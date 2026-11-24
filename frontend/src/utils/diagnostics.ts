import { enqueueDiagnosticEvent } from './diagnosticTransport';

export const diagnosticFlows = ['login', 'license', 'download', 'versions', 'account', 'settings'] as const;
export const diagnosticStages = [
  'action',
  'account_refresh',
  'account_save',
  'bag',
  'sap',
  'authentication',
  'verification',
  'bootstrap',
  'proof',
  'provision_start',
  'provision_finish',
  'kbsync',
  'purchase',
  'download_product',
  'version_lookup',
  'download_enqueue',
  'store_state',
  'lock',
  'clear_data',
  'settings',
  'download_fetch',
  'ipa_compile',
  'package_save',
  'task_state',
  'task_pause',
  'task_resume',
  'task_cancel',
  'transport',
  'apple_request',
] as const;
export const diagnosticOutcomes = [
  'start',
  'success',
  'failure',
  'retry',
  'transition',
  'cancelled',
  'blocked',
] as const;
export const diagnosticReasons = [
  'network',
  'timeout',
  'cancelled',
  'http_error',
  'invalid_response',
  'invalid_plist',
  'empty_response',
  'unexpected_response',
  'invalid_request',
  'not_ready',
  'busy',
  'expired',
  'not_provisioned',
  'storage',
  'missing_state',
  'state_conflict',
  'protocol_action',
  'verification_required',
  'terms_required',
  'token_expired',
  'device_verification',
  'unavailable',
  'already_owned',
  'paid_app',
  'access_denied',
  'not_found',
  'unsupported',
  'unknown',
  'cache_hit',
  'cache_miss',
  'fallback',
  'retry_exhausted',
  'lock_wait',
  'lock_acquired',
  'lock_timeout',
  'cleared',
  'redirect',
  'subscription_required',
  'license_required',
  'version_mismatch',
] as const;
export const diagnosticEndpoints = [
  'native_auth',
  'legacy_auth',
  'purchase',
  'ent_download',
  'volume_download',
  'redownload',
  'update',
  'bag',
  'sap',
  'helper',
  'public_version',
  'backend_downloads',
  'wasm',
  'wisp',
] as const;
export const diagnosticErrorCodes = [
  'INVALID_REQUEST',
  'REQUEST_TOO_LARGE',
  'NOT_PROVISIONED',
  'PROVISIONING_EXPIRED',
  'PROVISIONING_BUSY',
  'HELPER_UNAVAILABLE',
  'HELPER_LOADING',
  'PROOF_FAILED',
  'PROOF_TIMEOUT',
  'HELPER_FAILED',
  'INVALID_CONTENT_TYPE',
  'METHOD_NOT_ALLOWED',
  'NOT_FOUND',
  'BUSY',
] as const;

export interface DiagnosticDetails {
  httpStatus?: number;
  attempt?: number;
  durationMs?: number;
  retryDelayMs?: number;
  errorCode?: string;
  reason?: (typeof diagnosticReasons)[number];
  endpoint?: (typeof diagnosticEndpoints)[number];
  mode?: 'bootstrap' | 'store' | 'identity';
  alreadyOwned?: boolean;
  codeRequired?: boolean;
  statePresent?: boolean;
  action?: 'RP' | 'SP';
  responseType?: 'purchaseSuccess' | 'buyProductFailure' | 'other' | 'missing';
  dialog?:
    | 'MZCommerce.CountryMismatch'
    | 'MZCommerce.ExpiredPasswordToken'
    | 'MZCommerce.SystemError'
    | 'other'
    | 'missing';
}

export interface DiagnosticEvent extends DiagnosticDetails {
  schema: 1;
  flowId: string;
  sequence: number;
  flow: (typeof diagnosticFlows)[number];
  stage: (typeof diagnosticStages)[number];
  outcome: (typeof diagnosticOutcomes)[number];
  at: number;
}

export interface DiagnosticFlow {
  readonly id: string;
  log(stage: DiagnosticEvent['stage'], outcome: DiagnosticEvent['outcome'], details?: DiagnosticDetails): void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageKey = 'asspp-diagnostics-v1';
const historyLimit = 200;
let history: DiagnosticEvent[] | undefined;

function included<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Copy only public, bounded protocol facts. Never serialize an Error, URL, request, or response. */
export function safeDiagnosticDetails(details: DiagnosticDetails): DiagnosticDetails {
  const safe: DiagnosticDetails = {};
  for (const key of ['httpStatus', 'attempt', 'durationMs', 'retryDelayMs'] as const) {
    const value = details[key];
    const maximum = key === 'httpStatus' ? 599 : key === 'attempt' ? 1000 : 604_800_000;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum) {
      safe[key] = Math.round(value);
    }
  }
  const code = details.errorCode;
  if (typeof code === 'string' && (/^-?\d{1,10}$/.test(code) || included(diagnosticErrorCodes, code))) {
    safe.errorCode = code;
  }
  if (included(diagnosticReasons, details.reason)) safe.reason = details.reason;
  if (included(diagnosticEndpoints, details.endpoint)) safe.endpoint = details.endpoint;
  if (included(['bootstrap', 'store', 'identity'], details.mode)) safe.mode = details.mode;
  if (included(['RP', 'SP'], details.action)) safe.action = details.action;
  if (included(['purchaseSuccess', 'buyProductFailure', 'other', 'missing'], details.responseType)) {
    safe.responseType = details.responseType;
  }
  if (
    included(
      ['MZCommerce.CountryMismatch', 'MZCommerce.ExpiredPasswordToken', 'MZCommerce.SystemError', 'other', 'missing'],
      details.dialog,
    )
  ) {
    safe.dialog = details.dialog;
  }
  for (const key of ['alreadyOwned', 'codeRequired', 'statePresent'] as const) {
    if (typeof details[key] === 'boolean') safe[key] = details[key];
  }
  return safe;
}

function readEvent(value: unknown): DiagnosticEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as DiagnosticEvent;
  if (
    event.schema !== 1 ||
    typeof event.flowId !== 'string' ||
    !uuidPattern.test(event.flowId) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.sequence > 1_000_000 ||
    !Number.isSafeInteger(event.at) ||
    event.at < 0 ||
    !included(diagnosticFlows, event.flow) ||
    !included(diagnosticStages, event.stage) ||
    !included(diagnosticOutcomes, event.outcome)
  )
    return undefined;
  return {
    schema: 1,
    flowId: event.flowId,
    sequence: event.sequence,
    flow: event.flow,
    stage: event.stage,
    outcome: event.outcome,
    at: event.at,
    ...safeDiagnosticDetails(event),
  };
}

function currentHistory(): DiagnosticEvent[] {
  if (history) return history;
  history = [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(stored))
      history = stored
        .slice(-historyLimit)
        .map(readEvent)
        .filter((event): event is DiagnosticEvent => !!event);
  } catch {
    // Private browsing and quota failures must not block account operations.
  }
  return history;
}

export function getDiagnosticEvents(): DiagnosticEvent[] {
  return currentHistory().map((event) => ({ ...event }));
}

export function clearDiagnosticEvents(): void {
  history = [];
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* Keep the in-memory history empty. */
  }
}

function randomFlowId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createDiagnosticFlow(flow: DiagnosticEvent['flow']): DiagnosticFlow {
  const id = randomFlowId();
  let sequence = 0;
  return {
    id,
    log(stage, outcome, details = {}) {
      try {
        const event = readEvent({
          schema: 1,
          flowId: id,
          sequence: ++sequence,
          flow,
          stage,
          outcome,
          at: Date.now(),
          ...safeDiagnosticDetails(details),
        });
        if (!event) return;
        const events = currentHistory();
        events.push(event);
        if (events.length > historyLimit) events.splice(0, events.length - historyLimit);
        try {
          localStorage.setItem(storageKey, JSON.stringify(events));
        } catch {
          /* The bounded memory copy remains exportable. */
        }
        enqueueDiagnosticEvent(event);
      } catch {
        // Diagnostics are observational: logging must never change a protocol result.
      }
    },
  };
}

export function errorDiagnosticDetails(error: unknown): DiagnosticDetails {
  if (!error || typeof error !== 'object') return { reason: 'unknown' };
  const value = error as { code?: unknown; name?: unknown; codeRequired?: unknown; diagnostics?: DiagnosticDetails };
  const safe =
    value.diagnostics && typeof value.diagnostics === 'object' ? safeDiagnosticDetails(value.diagnostics) : {};
  const code = typeof value.code === 'string' ? safeDiagnosticDetails({ errorCode: value.code }).errorCode : undefined;
  if (code) safe.errorCode = code;
  if (value.codeRequired === true) return { ...safe, reason: 'verification_required', codeRequired: true };
  if (value.name === 'AbortError') return { ...safe, reason: 'cancelled' };
  if (value.name === 'TimeoutError' || code === 'PROOF_TIMEOUT') return { ...safe, reason: 'timeout' };
  if (['2034', '2042'].includes(code || '')) return { ...safe, reason: 'token_expired' };
  if (code === '1008') return { ...safe, reason: 'device_verification' };
  if (code === 'NOT_PROVISIONED') return { ...safe, reason: 'not_provisioned' };
  if (code === 'PROVISIONING_EXPIRED') return { ...safe, reason: 'expired' };
  if (['BUSY', 'PROVISIONING_BUSY'].includes(code || '')) return { ...safe, reason: 'busy' };
  return { reason: 'unknown', ...safe };
}

export function attachDiagnosticId<T>(error: T, flowId: string): T {
  if (error && typeof error === 'object' && uuidPattern.test(flowId)) {
    try {
      Object.defineProperty(error, 'diagnosticId', { value: flowId, configurable: true });
    } catch {
      /* Frozen errors keep their original identity. */
    }
  }
  return error;
}

export function getDiagnosticId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { diagnosticId?: unknown }).diagnosticId;
  return typeof value === 'string' && uuidPattern.test(value) ? value : undefined;
}
