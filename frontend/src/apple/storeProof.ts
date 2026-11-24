import { deleteDB, openDB } from 'idb';
import { authHeaders } from '../api/client';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { toBase64 } from './sap/bytes';
import { createDiagnosticFlow, errorDiagnosticDetails, attachDiagnosticId } from '../utils/diagnostics';
import type { IDBPDatabase } from 'idb';
import type { DiagnosticFlow, DiagnosticEvent, DiagnosticDetails } from '../utils/diagnostics';
import type { Cookie } from '../types';

const DB_NAME = 'asspp-store-proof';
const STORE_NAME = 'states';
const MAX_VALUE_LENGTH = 3 * 1024 * 1024;
const FINISH_PATH = '/auth/v1/otp/1.5/finish';
const queues = new Map<string, Promise<void>>();
let database: Promise<IDBPDatabase> | undefined;
let clearing = Promise.resolve();

export type StoreProofMode = 'store' | 'bootstrap';
export interface StoreProofBootstrap {
  headers: Record<string, string>;
  mode: StoreProofMode;
}

export class StoreProofError extends Error {
  constructor(
    message: string,
    public readonly code = 'STORE_PROOF_FAILED',
    public readonly diagnostics: DiagnosticDetails = { reason: 'invalid_response' },
  ) {
    super(message);
    this.name = 'StoreProofError';
  }
}

function getDatabase(): Promise<IDBPDatabase> {
  if (database) return database;
  const opening = openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME);
    },
    blocking() {
      void opening.then((db) => db.close());
      if (database === opening) database = undefined;
    },
    terminated() {
      if (database === opening) database = undefined;
    },
  });
  database = opening;
  void opening.catch(() => {
    if (database === opening) database = undefined;
  });
  return opening;
}

async function databaseLock<T>(mode: 'shared' | 'exclusive', action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return await navigator.locks.request('asspp-store-proof:database', { mode }, action);
  }
  return await action();
}

// Promise queues also cover browsers without Web Locks. The Web Lock makes the
// read -> proof generation -> updated state write atomic across tabs as well.
async function serialized<T>(deviceId: string, action: () => Promise<T>, flow: DiagnosticFlow): Promise<T> {
  const started = Date.now();
  let acquired = false;
  flow.log('lock', 'start', { reason: 'lock_wait' });
  const locked = async () => {
    acquired = true;
    flow.log('lock', 'transition', { reason: 'lock_acquired', durationMs: Date.now() - started });
    try {
      return await action();
    } finally {
      flow.log('lock', 'success', { reason: 'lock_acquired', durationMs: Date.now() - started });
    }
  };
  const previous = queues.get(deviceId) ?? Promise.resolve();
  // Capture the current clear barrier before a later clear snapshots this queue.
  const run = Promise.all([previous, clearing]).then(() =>
    databaseLock('shared', async () => {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request(`asspp-store-proof:${deviceId}`, locked);
      }
      return await locked();
    }),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(deviceId, tail);
  try {
    return await run;
  } catch (error) {
    if (!acquired)
      flow.log('lock', 'failure', {
        ...errorDiagnosticDetails(error),
        reason: 'storage',
        durationMs: Date.now() - started,
      });
    throw error;
  } finally {
    if (queues.get(deviceId) === tail) queues.delete(deviceId);
  }
}

function opaque(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE_LENGTH || /[\r\n]/.test(value)) {
    throw new StoreProofError(`Invalid ${label} in device verification response`);
  }
  return value;
}

const allowedHeaders = new Set([
  'x-apple-amd',
  'x-apple-amd-m',
  'x-apple-i-client-time',
  'x-apple-i-md-rinfo',
  'x-apple-i-md-lu',
  'x-apple-i-srl-no',
  'x-apple-i-timezone',
  'x-apple-locale',
  'x-mme-device-id',
  'x-mme-client-info',
]);

function proofHeaders(value: unknown, requireProof = true): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreProofError('Invalid device verification headers');
  }
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      !allowedHeaders.has(name.toLowerCase()) ||
      typeof entry !== 'string' ||
      !entry ||
      entry.length > 32768 ||
      /[^\x20-\x7e]/.test(entry)
    ) {
      throw new StoreProofError('Invalid device verification header');
    }
    headers[name] = entry;
  }
  const keys = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (requireProof && (!keys.has('x-apple-amd') || !keys.has('x-apple-amd-m'))) {
    throw new StoreProofError('Device verification proof is incomplete');
  }
  return headers;
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new StoreProofError('Invalid Store proof endpoint');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname.includes('%') ||
    endpoint.includes('#')
  ) {
    throw new StoreProofError('Invalid Store proof endpoint');
  }
  if (url.hostname === 'auth.itunes.apple.com' && /^\/auth\/v1\/native(?:\/fast)?\/?$/.test(url.pathname)) return;
  const buyHost = /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname);
  if (buyHost && /^\/WebObjects\/MZFinance\.woa\/wa\/authenticate\/?$/.test(url.pathname)) return;
  const commercePath =
    (buyHost && url.pathname === '/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct') ||
    (url.hostname === 'downloaddispatch.itunes.apple.com' &&
      ['/r/redownload', '/up/updateProduct', '/WebObjects/DownloadDispatch.woa/wa/ent/download'].includes(
        url.pathname,
      ));
  if (commercePath && Array.from(url.searchParams.keys()).length === 1 && url.searchParams.get('guid')) return;
  throw new StoreProofError('Store proof endpoint is not allowed');
}

async function timedFetch(path: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } catch {
    throw new StoreProofError(
      'Device verification could not reach the server. Try again shortly.',
      'HELPER_UNAVAILABLE',
      { reason: controller.signal.aborted ? 'timeout' : 'network' },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request(
  payload: Record<string, unknown>,
  flow: DiagnosticFlow,
  stage: DiagnosticEvent['stage'],
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await timedFetch(
      '/api/store-proof',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(), 'X-Asspp-Flow-Id': flow.id },
        body: JSON.stringify(payload),
      },
      120_000,
    );
  } catch (error) {
    flow.log(stage, 'failure', { ...errorDiagnosticDetails(error), endpoint: 'helper' });
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  flow.log(stage, response.ok ? 'transition' : 'failure', {
    endpoint: 'helper',
    httpStatus: response.status,
    ...(response.ok ? {} : { reason: 'http_error' as const }),
  });
  if (!response.ok) {
    // Do not reflect arbitrary response bodies, Apple challenges, or state in UI.
    const code =
      typeof result?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(result.error.code)
        ? result.error.code
        : 'STORE_PROOF_FAILED';
    throw new StoreProofError(
      code === 'NOT_PROVISIONED'
        ? 'Device verification has expired. Re-authenticate this account.'
        : `Device verification failed (${code}; HTTP ${response.status}). Try signing in again.`,
      code,
      { httpStatus: response.status, reason: 'http_error' },
    );
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new StoreProofError('Invalid device verification response');
  }
  return result;
}

async function waitForReady(flow: DiagnosticFlow, stage: DiagnosticEvent['stage']): Promise<void> {
  const started = Date.now();
  const deadline = Date.now() + 10 * 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    let response: Response | undefined;
    try {
      response = await timedFetch(
        '/api/store-proof/health',
        { headers: { ...authHeaders(), 'X-Asspp-Flow-Id': flow.id } },
        10_000,
      );
    } catch (error) {
      if (!(error instanceof StoreProofError) || error.code !== 'HELPER_UNAVAILABLE') throw error;
    }
    if (response) {
      const health = await response.json().catch(() => ({}));
      if (response.ok && health.status === 'ready') {
        flow.log(stage, 'transition', {
          endpoint: 'helper',
          httpStatus: response.status,
          attempt,
          durationMs: Date.now() - started,
        });
        return;
      }
      if (health.status === 'error' || (health.status !== 'loading' && ![502, 503, 504].includes(response.status))) {
        flow.log(stage, 'blocked', { endpoint: 'helper', httpStatus: response.status, reason: 'unavailable', attempt });
        throw new StoreProofError('Device verification is unavailable. Check the server status.', 'HELPER_UNAVAILABLE');
      }
    }
    flow.log(stage, 'retry', {
      endpoint: 'helper',
      httpStatus: response?.status,
      reason: 'not_ready',
      attempt,
      retryDelayMs: 3000,
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new StoreProofError('Device verification is still preparing. Try again shortly.', 'HELPER_LOADING');
}

/** Only machine proof material crosses this API; Apple credentials stay in the browser. */
export class StoreProofClient {
  private readonly deviceId: string;
  private readonly flow: DiagnosticFlow;

  constructor(deviceId: string, flow: DiagnosticFlow = createDiagnosticFlow('login')) {
    this.flow = flow;
    if (!/^[a-fA-F0-9]{12}$/.test(deviceId)) {
      flow.log('store_state', 'blocked', { reason: 'invalid_request' });
      throw attachDiagnosticId(
        new StoreProofError('Device ID must contain 12 hexadecimal characters', 'INVALID_REQUEST'),
        flow.id,
      );
    }
    this.deviceId = deviceId.toUpperCase();
  }

  /** Finish pending writes before deletion; later calls open a fresh database. */
  static clearAll(flow: DiagnosticFlow = createDiagnosticFlow('settings'), onBlocked?: () => void): Promise<void> {
    const started = Date.now();
    flow.log('clear_data', 'start', { reason: 'lock_wait' });
    const finished = Promise.all([clearing, ...queues.values()])
      .then(() =>
        databaseLock('exclusive', async () => {
          const opened = database;
          database = undefined;
          if (opened) (await opened).close();
          await deleteDB(DB_NAME, {
            blocked() {
              flow.log('clear_data', 'blocked', { reason: 'busy' });
              onBlocked?.();
            },
          });
          flow.log('store_state', 'success', { reason: 'cleared', statePresent: false });
        }),
      )
      .then(
        () => {
          flow.log('clear_data', 'success', { reason: 'cleared', durationMs: Date.now() - started });
        },
        (error) => {
          flow.log('clear_data', 'failure', {
            ...errorDiagnosticDetails(error),
            reason: 'storage',
            durationMs: Date.now() - started,
          });
          throw attachDiagnosticId(error, flow.id);
        },
      );
    clearing = finished.catch(() => undefined);
    return finished;
  }

  private async run<T>(stage: DiagnosticEvent['stage'], action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.flow.log(stage, 'start', { endpoint: 'helper' });
    try {
      const result = await serialized(this.deviceId, action, this.flow);
      this.flow.log(stage, 'success', { endpoint: 'helper', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      this.flow.log(stage, 'failure', {
        ...errorDiagnosticDetails(error),
        endpoint: 'helper',
        durationMs: Date.now() - started,
      });
      throw attachDiagnosticId(error, this.flow.id);
    }
  }

  private async readState(): Promise<string | undefined> {
    this.flow.log('store_state', 'start', { reason: 'storage' });
    try {
      const state = await (await getDatabase()).get(STORE_NAME, this.deviceId);
      this.flow.log('store_state', 'success', { statePresent: !!state, reason: state ? 'cache_hit' : 'cache_miss' });
      return state;
    } catch (error) {
      this.flow.log('store_state', 'failure', { reason: 'storage' });
      throw error;
    }
  }

  private async writeState(value: unknown): Promise<void> {
    this.flow.log('store_state', 'start', { reason: 'storage' });
    try {
      const state = opaque(value, 'state');
      await (await getDatabase()).put(STORE_NAME, state, this.deviceId);
      this.flow.log('store_state', 'success', { reason: 'storage', statePresent: true });
    } catch (error) {
      this.flow.log('store_state', 'failure', { reason: 'storage' });
      throw error;
    }
  }

  async bootstrap(endpoint: string): Promise<StoreProofBootstrap> {
    return this.run('bootstrap', async () => {
      validateEndpoint(endpoint);
      await waitForReady(this.flow, 'bootstrap');
      const state = await this.readState();
      const result = await request(
        {
          operation: 'bootstrap',
          deviceId: this.deviceId,
          endpoint,
          ...(state ? { state } : {}),
        },
        this.flow,
        'bootstrap',
      );
      const headers = proofHeaders(result.headers);
      if (result.mode !== 'store' && result.mode !== 'bootstrap')
        throw new StoreProofError('Invalid device verification mode');
      await this.writeState(result.state);
      this.flow.log('bootstrap', 'transition', { mode: result.mode });
      return { headers, mode: result.mode };
    });
  }

  async proof(endpoint: string): Promise<Record<string, string>> {
    return this.run('proof', async () => {
      validateEndpoint(endpoint);
      const state = await this.readState();
      if (!state)
        throw new StoreProofError('Re-authenticate this account to prepare device verification.', 'NOT_PROVISIONED');
      await waitForReady(this.flow, 'proof');
      const result = await request(
        { operation: 'proof', deviceId: this.deviceId, endpoint, state },
        this.flow,
        'proof',
      );
      const headers = proofHeaders(result.headers);
      await this.writeState(result.state);
      return headers;
    });
  }

  async provision(challenge: string, cookies: Cookie[]): Promise<Cookie[]> {
    return this.run('provision_finish', async () => {
      const state = await this.readState();
      if (!state)
        throw new StoreProofError('Device verification must be initialized before provisioning', 'NOT_PROVISIONED');
      this.flow.log('provision_start', 'start', { endpoint: 'helper' });
      const started = await request(
        {
          operation: 'provision-start',
          deviceId: this.deviceId,
          state,
          challenge: opaque(challenge, 'challenge'),
        },
        this.flow,
        'provision_start',
      );
      const pending = opaque(started.pending, 'provisioning session');
      this.flow.log('provision_start', 'success', { endpoint: 'helper' });
      const headers = proofHeaders(started.identityHeaders, false);
      for (const name of Object.keys(headers)) {
        if (['x-apple-amd', 'x-apple-amd-m', 'x-apple-i-md-rinfo'].includes(name.toLowerCase())) delete headers[name];
      }
      this.flow.log('provision_finish', 'transition', { endpoint: 'native_auth' });
      const response = await appleRequest({
        method: 'POST',
        host: 'auth.itunes.apple.com',
        path: FINISH_PATH,
        headers: { ...headers, Accept: '*/*', 'Content-Type': 'application/x-apple-plist' },
        body: buildPlist({
          clientData: opaque(started.clientData, 'client data'),
          kbsync: opaque(started.kbsync, 'key synchronization'),
        }),
        cookies,
        diagnostics: this.flow,
      });
      this.flow.log('provision_finish', 'transition', { endpoint: 'native_auth', httpStatus: response.status });
      const updatedCookies = extractAndMergeCookies(response.rawHeaders, cookies);
      if (response.status !== 200)
        throw new StoreProofError(`Apple device provisioning failed (HTTP ${response.status})`);
      let result: Record<string, any>;
      try {
        result = parsePlist(response.body);
      } catch {
        throw new StoreProofError('Apple returned invalid device provisioning data');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new StoreProofError('Apple returned invalid device provisioning data');
      const keybag = result.keybag instanceof Uint8Array ? toBase64(result.keybag) : result.keybag;
      const completed = await request(
        {
          operation: 'provision-finish',
          deviceId: this.deviceId,
          pending,
          settingInfo: opaque(result.settingInfo, 'setting information'),
          transportKey: opaque(result.transportKey, 'transport key'),
          ...(keybag ? { keybag: opaque(keybag, 'keybag') } : {}),
        },
        this.flow,
        'provision_finish',
      );
      await this.writeState(completed.state);
      return updatedCookies;
    });
  }

  async kbsync(dsid: string): Promise<string> {
    return this.run('kbsync', async () => {
      if (!/^\d{1,20}$/.test(dsid) || BigInt(dsid) <= 0n || BigInt(dsid) > 0xffffffffffffffffn) {
        throw new StoreProofError('Key synchronization requires a numeric account ID');
      }
      await waitForReady(this.flow, 'kbsync');
      const result = await request({ operation: 'kbsync', deviceId: this.deviceId, dsid }, this.flow, 'kbsync');
      return opaque(result.kbsync, 'key synchronization');
    });
  }
}
