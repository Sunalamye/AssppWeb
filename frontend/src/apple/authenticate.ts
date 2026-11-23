import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { fetchBag, normalizeAuthURL } from './bag';
import { connectSAP } from './sap';
import { toBase64 } from './sap/bytes';
import { StoreProofClient } from './storeProof';
import type { StoreProofMode } from './storeProof';
import type { SAPSigner } from './sap/signer';
import type { Account, Cookie } from '../types';

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface AuthRetry {
  status: number;
  attempt: number;
  attempts: number;
  delayMs: number;
}

export type AuthPhase = 'preparing' | 'signingIn' | 'provisioning' | 'verifying';
const AUTH_REQUEST_ATTEMPTS = 3;
const AUTH_RETRY_DELAY_MS = 10_000;
const MAX_AUTH_RETRY_DELAY_MS = 30_000;
const MAX_AUTH_REDIRECTS = 4;

function isTransientAuthStatus(status: number): boolean {
  return [204, 403, 404, 429].includes(status) || Math.floor(status / 100) === 5;
}

function retryAfterMs(header: string | undefined): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

type AuthResponse = Awaited<ReturnType<typeof appleRequest>>;

function responseDictionary(response: AuthResponse): Record<string, any> | undefined {
  if (!response.body.trim()) return undefined;
  try {
    const value = parsePlist(response.body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* A safe stage/status diagnostic is produced by the caller. */
  }
  return undefined;
}

async function sendWithTransientRetry(
  send: () => Promise<AuthResponse>,
  onRetry?: (retry: AuthRetry) => void,
): Promise<AuthResponse> {
  const statuses: number[] = [];
  for (;;) {
    const response = await send();
    // RP/SP is a protocol transition, including when Apple sends an empty body.
    if (response.headers['x-apple-amd-action']) return response;
    if (!isTransientAuthStatus(response.status)) return response;
    const dict = responseDictionary(response);
    // Never turn a populated account/credential error into automatic retries.
    if (dict && (dict.failureType || dict.customerMessage || dict.dialog)) return response;
    statuses.push(response.status);
    if (statuses.length === AUTH_REQUEST_ATTEMPTS) {
      throw new AuthenticationError(
        i18n.t('errors.auth.transientFailure', {
          attempts: AUTH_REQUEST_ATTEMPTS,
          statuses: statuses.join(', '),
        }),
      );
    }
    let delayMs = Math.min(AUTH_RETRY_DELAY_MS * 2 ** (statuses.length - 1), MAX_AUTH_RETRY_DELAY_MS);
    const requested = retryAfterMs(response.headers['retry-after']);
    if (requested !== undefined) {
      if (requested > MAX_AUTH_RETRY_DELAY_MS) {
        throw new AuthenticationError(i18n.t('errors.auth.retryLater', { seconds: Math.ceil(requested / 1000) }));
      }
      delayMs = Math.max(requested, 1000);
    }
    onRetry?.({ status: response.status, attempt: statuses.length + 1, attempts: AUTH_REQUEST_ATTEMPTS, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function approvedAuthEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthenticationError('Authentication requires an approved Apple HTTPS endpoint');
  }
  const native = url.hostname === 'auth.itunes.apple.com' && /^\/auth\/v1\/native(?:\/fast)?\/?$/.test(url.pathname);
  const legacy =
    /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
    /^\/WebObjects\/MZFinance\.woa\/wa\/authenticate\/?$/.test(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    value.includes('#') ||
    url.pathname.includes('%') ||
    (!native && !legacy)
  ) {
    throw new AuthenticationError('Authentication requires an approved Apple HTTPS endpoint');
  }
  return new URL(normalizeAuthURL(url.toString()));
}

interface AuthSession {
  signer: SAPSigner;
  proof: StoreProofClient;
  mode: StoreProofMode | 'identity';
  headers: Record<string, string>;
  preparedEndpoint?: string;
  cookies: Cookie[];
  storeFront: string;
  endpoint: string;
  pod?: string;
  removedProof: boolean;
  provisioned: boolean;
}

// Verified against ipatool v2.8.1's AppleMediaServices encoder with two pairs
// of synthetic credentials. Only appleId/password differ between captures.
function nativeBody(email: string, password: string, code: string, deviceId: string, attempt: number) {
  return buildPlist({
    appleId: email,
    attempt: String(attempt),
    createSession: true,
    credentialSource: 0,
    deviceOffersCheck: 'true',
    guid: deviceId,
    isSilentAuthentication: false,
    password: password + code,
    passwordSettings: { free: 'always', paid: 'always' },
    rmp: '0',
    why: 'signIn',
  });
}

function responseDSID(dict: Record<string, any>, response: AuthResponse): string {
  for (const candidate of [dict.dsPersonId, response.headers['x-dsid']]) {
    const value = String(candidate ?? '').trim();
    if (/^[1-9]\d*$/.test(value)) return value;
  }
  for (const [name, header] of response.rawHeaders) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    const match = /(?:^|[ ,])mz_at(?:0|_ssl)-(\d+)=/.exec(header);
    if (match && match[1] !== '0') return match[1];
  }
  return '';
}

function identityHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !['x-apple-amd', 'x-apple-amd-m', 'x-apple-i-md', 'x-apple-i-md-m', 'x-apple-i-md-rinfo'].includes(
          name.toLowerCase(),
        ),
    ),
  );
}

/** Retain this instance when continuing with a verification code. */
export class Authenticator {
  private session?: AuthSession;
  private continuation?: { email: string; password: string };
  private busy = false;

  constructor(
    private readonly deviceId: string,
    private readonly existingCookies: Cookie[] = [],
  ) {}

  private async connect(): Promise<AuthSession> {
    const bag = await fetchBag(this.deviceId);
    const endpoint = approvedAuthEndpoint(bag.authURL).toString();
    const proof = new StoreProofClient(this.deviceId);
    const signer = await connectSAP();
    const machine = await proof.bootstrap(endpoint);
    return {
      signer,
      proof,
      mode: machine.mode,
      headers: machine.headers,
      preparedEndpoint: endpoint,
      cookies: [...this.existingCookies],
      storeFront: '',
      endpoint,
      removedProof: false,
      provisioned: false,
    };
  }

  private async requestProof(session: AuthSession): Promise<Record<string, string>> {
    if (session.mode === 'identity') return session.headers;
    if (session.preparedEndpoint === session.endpoint) {
      session.preparedEndpoint = undefined;
      return session.headers;
    }
    if (session.mode === 'bootstrap') {
      const refreshed = await session.proof.bootstrap(session.endpoint);
      session.mode = refreshed.mode;
      session.headers = refreshed.headers;
    } else {
      session.headers = await session.proof.proof(session.endpoint);
    }
    return session.headers;
  }

  async authenticate(
    email: string,
    password: string,
    code?: string,
    onRetry?: (retry: AuthRetry) => void,
    onProgress?: (phase: AuthPhase) => void,
  ): Promise<Account> {
    if (this.busy) throw new AuthenticationError('An authentication request is already in progress');
    const verificationCode = code?.replace(/\s/g, '') ?? '';
    if (code !== undefined && !/^\d{6}$/.test(verificationCode))
      throw new AuthenticationError('Verification code must contain six digits', !!this.session);
    // The SAP/cookie continuation belongs to the credentials that requested 2FA.
    if (!verificationCode || this.continuation?.email !== email || this.continuation?.password !== password) {
      this.session = undefined;
      this.continuation = undefined;
    }
    this.busy = true;
    let needsCode = false;
    try {
      onProgress?.('preparing');
      const session = (this.session ??= await this.connect());
      let attempt = verificationCode ? 2 : 1;
      let redirects = 0;
      for (;;) {
        onProgress?.(verificationCode ? 'verifying' : 'signingIn');
        const plistBody = nativeBody(email, password, verificationCode, this.deviceId, attempt);
        const response = await sendWithTransientRetry(async () => {
          const proof = await this.requestProof(session);
          const endpoint = approvedAuthEndpoint(session.endpoint);
          const headers = {
            ...proof,
            'Content-Type': 'application/x-apple-plist',
            'Accept-Language': 'en',
            'X-Apple-Client-Application': 'me.majd.ipatool',
            'X-Apple-Tz': '0',
            'X-Apple-ActionSignature': toBase64(await session.signer.sign(new TextEncoder().encode(plistBody))),
          };
          const sent = await appleRequest({
            method: 'POST',
            host: endpoint.hostname,
            path: endpoint.pathname + endpoint.search,
            headers,
            body: plistBody,
            cookies: session.cookies,
          });
          session.cookies = extractAndMergeCookies(sent.rawHeaders, session.cookies);
          return sent;
        }, onRetry);

        const storeFront =
          response.headers['x-set-apple-store-front'] ?? response.headers['x-apple-request-store-front'];
        if (storeFront) session.storeFront = storeFront;
        const pod = response.headers.pod;
        if (pod && /^\d+$/.test(pod)) session.pod = pod;

        const action = response.headers['x-apple-amd-action']?.trim();
        if (action) {
          if (action === 'RP' && !session.removedProof && !session.provisioned) {
            session.removedProof = true;
            session.mode = 'identity';
            session.headers = identityHeaders(session.headers);
            session.preparedEndpoint = undefined;
            session.signer = await connectSAP();
            continue;
          }
          if (action === 'SP' && !session.provisioned) {
            const challenge = response.headers['x-apple-amd-data'];
            if (!challenge) throw new AuthenticationError('Apple device provisioning challenge is missing');
            session.provisioned = true;
            onProgress?.('provisioning');
            session.cookies = await session.proof.provision(challenge, session.cookies);
            session.mode = 'store';
            session.preparedEndpoint = undefined;
            session.signer = await connectSAP();
            continue;
          }
          throw new AuthenticationError('Apple device verification did not complete. Start a new sign-in.');
        }

        if (response.status >= 300 && response.status < 400) {
          if (![301, 302, 307, 308].includes(response.status)) {
            throw new AuthenticationError(`Unsupported authentication redirect (HTTP ${response.status})`);
          }
          if (++redirects > MAX_AUTH_REDIRECTS) throw new AuthenticationError('Too many authentication redirects');
          const location = response.headers.location;
          if (!location?.trim()) throw new AuthenticationError(i18n.t('errors.auth.redirectLocation'));
          session.endpoint = approvedAuthEndpoint(new URL(location, session.endpoint).toString()).toString();
          continue;
        }

        const dict = responseDictionary(response);
        if (!dict) throw new AuthenticationError(i18n.t('errors.auth.emptyBody', { status: response.status }));
        const failure = String(dict.failureType ?? '');
        if (failure === '-5000' && attempt === 1) {
          attempt = 2;
          continue;
        }
        if (!failure && dict.customerMessage === 'MZFinance.BadLogin.Configurator_message') {
          if (!verificationCode) throw new AuthenticationError(i18n.t('errors.auth.requiresVerification'), true);
          throw new AuthenticationError('Apple did not complete verification. Enter a fresh verification code.', true);
        }
        const failureMessage = dict.dialog?.explanation ?? dict.dialog?.message ?? dict.customerMessage;
        if (failure || dict.dialog || dict.customerMessage === 'Your account is disabled.') {
          throw new AuthenticationError(
            typeof failureMessage === 'string' && failureMessage
              ? failureMessage
              : 'Apple rejected the authentication request',
          );
        }
        const token = typeof dict.passwordToken === 'string' ? dict.passwordToken : '';
        const dsid = responseDSID(dict, response);
        if (response.status !== 200 || !token || !dsid) {
          throw new AuthenticationError(
            `Apple returned no usable authentication response (HTTP ${response.status}); missing account credentials`,
          );
        }
        const accountInfo = dict.accountInfo ?? {};
        const address = accountInfo.address ?? {};
        return {
          email,
          password,
          appleId: typeof accountInfo.appleId === 'string' ? accountInfo.appleId : email,
          store: session.storeFront.split('-')[0].split(',')[0],
          storeFront: session.storeFront,
          firstName: typeof address.firstName === 'string' ? address.firstName : '',
          lastName: typeof address.lastName === 'string' ? address.lastName : '',
          passwordToken: token,
          directoryServicesIdentifier: dsid,
          cookies: session.cookies,
          deviceIdentifier: this.deviceId,
          pod: session.pod,
        };
      }
    } catch (error) {
      if (error instanceof AuthenticationError && error.codeRequired) {
        needsCode = true;
        this.continuation = { email, password };
      }
      throw error;
    } finally {
      // Failed provisioning must not leave RP/SP flags or a partially used SAP
      // session behind. The last valid opaque device state remains in IndexedDB.
      if (!needsCode) {
        this.session = undefined;
        this.continuation = undefined;
      }
      this.busy = false;
    }
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = '',
  onRetry?: (retry: AuthRetry) => void,
  onProgress?: (phase: AuthPhase) => void,
): Promise<Account> {
  return new Authenticator(deviceId, existingCookies).authenticate(email, password, code, onRetry, onProgress);
}
