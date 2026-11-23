import { deleteDB, openDB } from 'idb';
import { authHeaders } from '../api/client';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { toBase64 } from './sap/bytes';
import type { IDBPDatabase } from 'idb';
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
async function serialized<T>(deviceId: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(deviceId) ?? Promise.resolve();
  // Capture the current clear barrier before a later clear snapshots this queue.
  const run = Promise.all([previous, clearing]).then(() =>
    databaseLock('shared', async () => {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request(`asspp-store-proof:${deviceId}`, action);
      }
      return await action();
    }),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(deviceId, tail);
  try {
    return await run;
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
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request(payload: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await timedFetch(
    '/api/store-proof',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    },
    120_000,
  );
  const result = await response.json().catch(() => ({}));
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
    );
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new StoreProofError('Invalid device verification response');
  }
  return result;
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    let response: Response | undefined;
    try {
      response = await timedFetch('/api/store-proof/health', { headers: authHeaders() }, 10_000);
    } catch (error) {
      if (!(error instanceof StoreProofError) || error.code !== 'HELPER_UNAVAILABLE') throw error;
    }
    if (response) {
      const health = await response.json().catch(() => ({}));
      if (response.ok && health.status === 'ready') return;
      if (health.status === 'error' || (health.status !== 'loading' && ![502, 503, 504].includes(response.status))) {
        throw new StoreProofError('Device verification is unavailable. Check the server status.', 'HELPER_UNAVAILABLE');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new StoreProofError('Device verification is still preparing. Try again shortly.', 'HELPER_LOADING');
}

/** Only machine proof material crosses this API; Apple credentials stay in the browser. */
export class StoreProofClient {
  private readonly deviceId: string;

  constructor(deviceId: string) {
    if (!/^[a-fA-F0-9]{12}$/.test(deviceId))
      throw new StoreProofError('Device ID must contain 12 hexadecimal characters');
    this.deviceId = deviceId.toUpperCase();
  }

  /** Finish pending writes before deletion; later calls open a fresh database. */
  static clearAll(): Promise<void> {
    const finished = Promise.all([clearing, ...queues.values()]).then(() =>
      databaseLock('exclusive', async () => {
        const opened = database;
        database = undefined;
        if (opened) (await opened).close();
        await deleteDB(DB_NAME);
      }),
    );
    clearing = finished.catch(() => undefined);
    return finished;
  }

  async bootstrap(endpoint: string): Promise<StoreProofBootstrap> {
    validateEndpoint(endpoint);
    return serialized(this.deviceId, async () => {
      await waitForReady();
      const db = await getDatabase();
      const state = await db.get(STORE_NAME, this.deviceId);
      const result = await request({
        operation: 'bootstrap',
        deviceId: this.deviceId,
        endpoint,
        ...(state ? { state } : {}),
      });
      const headers = proofHeaders(result.headers);
      if (result.mode !== 'store' && result.mode !== 'bootstrap')
        throw new StoreProofError('Invalid device verification mode');
      await db.put(STORE_NAME, opaque(result.state, 'state'), this.deviceId);
      return { headers, mode: result.mode };
    });
  }

  async proof(endpoint: string): Promise<Record<string, string>> {
    validateEndpoint(endpoint);
    return serialized(this.deviceId, async () => {
      const db = await getDatabase();
      const state = await db.get(STORE_NAME, this.deviceId);
      if (!state)
        throw new StoreProofError('Re-authenticate this account to prepare device verification.', 'NOT_PROVISIONED');
      await waitForReady();
      const result = await request({ operation: 'proof', deviceId: this.deviceId, endpoint, state });
      const headers = proofHeaders(result.headers);
      await db.put(STORE_NAME, opaque(result.state, 'state'), this.deviceId);
      return headers;
    });
  }

  async provision(challenge: string, cookies: Cookie[]): Promise<Cookie[]> {
    return serialized(this.deviceId, async () => {
      const db = await getDatabase();
      const state = await db.get(STORE_NAME, this.deviceId);
      if (!state) throw new StoreProofError('Device verification must be initialized before provisioning');
      const started = await request({
        operation: 'provision-start',
        deviceId: this.deviceId,
        state,
        challenge: opaque(challenge, 'challenge'),
      });
      const pending = opaque(started.pending, 'provisioning session');
      const headers = proofHeaders(started.identityHeaders, false);
      for (const name of Object.keys(headers)) {
        if (['x-apple-amd', 'x-apple-amd-m', 'x-apple-i-md-rinfo'].includes(name.toLowerCase())) delete headers[name];
      }
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
      });
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
      const completed = await request({
        operation: 'provision-finish',
        deviceId: this.deviceId,
        pending,
        settingInfo: opaque(result.settingInfo, 'setting information'),
        transportKey: opaque(result.transportKey, 'transport key'),
        ...(keybag ? { keybag: opaque(keybag, 'keybag') } : {}),
      });
      await db.put(STORE_NAME, opaque(completed.state, 'state'), this.deviceId);
      return updatedCookies;
    });
  }

  async kbsync(dsid: string): Promise<string> {
    if (!/^\d+$/.test(dsid) || BigInt(dsid) <= 0n || BigInt(dsid) > 0xffffffffffffffffn) {
      throw new StoreProofError('Key synchronization requires a numeric account ID');
    }
    return serialized(this.deviceId, async () => {
      await waitForReady();
      const result = await request({ operation: 'kbsync', deviceId: this.deviceId, dsid });
      return opaque(result.kbsync, 'key synchronization');
    });
  }
}
