import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

// Keep the public schema aligned with frontend/src/utils/diagnostics.ts.
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

export const diagnosticPurchaseBranches = [
  'http_error',
  'invalid_plist',
  'invalid_failure_type',
  'invalid_customer_message',
  'terms_required',
  'device_verification',
  'token_expired',
  'subscription_required',
  'dialog_present',
  'action_present',
  'invalid_status',
  'unavailable',
  'already_owned',
  'conflicting_message',
  'failure_code',
  'customer_message',
  'missing_success_document',
  'missing_success_status',
  'success',
] as const;
export const diagnosticFailureTypeKinds = ['missing', 'empty', 'numeric', 'text', 'invalid'] as const;
export const diagnosticStatusKinds = ['missing', 'zero', 'nonzero', 'text', 'invalid'] as const;
export const diagnosticDialogKinds = [
  'missing',
  'authorization',
  'confirmation',
  'acknowledgement',
  'error',
  'other',
] as const;
export const diagnosticActionKinds = ['missing', 'Goto', 'Buy', 'Download', 'SignIn', 'other'] as const;

/** Syntax for Apple protocol identifiers only; never pass arbitrary messages here. */
export function validAppleDialogCode(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 160) return false;
  const segments = value.split('.');
  if (segments.length < 2 || !['MZCommerce', 'MZFinance', 'MZCommerceInAppBuy'].includes(segments[0])) return false;
  return segments.slice(1).every(
    (segment) =>
      segment.length >= 1 &&
      segment.length <= 48 &&
      // Equality enforces the true end of the string, including after line breaks.
      /^[A-Z][A-Za-z]*(?:[0-9]{1,2})?$/.exec(segment)?.[0] === segment,
  );
}

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
  dialogCode?: string;
  purchaseBranch?: (typeof diagnosticPurchaseBranches)[number];
  failureTypeKind?: (typeof diagnosticFailureTypeKinds)[number];
  statusKind?: (typeof diagnosticStatusKinds)[number];
  dialogPresent?: boolean;
  actionPresent?: boolean;
  messagePresent?: boolean;
  dialogKind?: (typeof diagnosticDialogKinds)[number];
  actionKind?: (typeof diagnosticActionKinds)[number];
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requiredFields = ['schema', 'flowId', 'sequence', 'flow', 'stage', 'outcome', 'at'] as const;
const detailFields = [
  'httpStatus',
  'attempt',
  'durationMs',
  'retryDelayMs',
  'errorCode',
  'reason',
  'endpoint',
  'mode',
  'alreadyOwned',
  'codeRequired',
  'statePresent',
  'action',
  'responseType',
  'dialog',
  'dialogCode',
  'purchaseBranch',
  'failureTypeKind',
  'statusKind',
  'dialogPresent',
  'actionPresent',
  'messagePresent',
  'dialogKind',
  'actionKind',
] as const;
const allowedFields = new Set<string>([...requiredFields, ...detailFields]);
const stringDetails: Record<string, readonly string[]> = {
  reason: diagnosticReasons,
  endpoint: diagnosticEndpoints,
  mode: ['bootstrap', 'store', 'identity'],
  action: ['RP', 'SP'],
  responseType: ['purchaseSuccess', 'buyProductFailure', 'other', 'missing'],
  dialog: [
    'MZCommerce.CountryMismatch',
    'MZCommerce.ExpiredPasswordToken',
    'MZCommerce.SystemError',
    'other',
    'missing',
  ],
  purchaseBranch: diagnosticPurchaseBranches,
  failureTypeKind: diagnosticFailureTypeKinds,
  statusKind: diagnosticStatusKinds,
  dialogKind: diagnosticDialogKinds,
  actionKind: diagnosticActionKinds,
};

export function validDiagnosticId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function validDiagnosticErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^-?\d{1,10}$/.test(value) || (diagnosticErrorCodes as readonly string[]).includes(value))
  );
}

function includes(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}

function validDetail(key: string, value: unknown): boolean {
  if (['httpStatus', 'attempt', 'durationMs', 'retryDelayMs'].includes(key)) {
    const maximum = key === 'httpStatus' ? 599 : key === 'attempt' ? 1000 : 604_800_000;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  }
  if (key === 'errorCode') return validDiagnosticErrorCode(value);
  if (key === 'dialogCode') return validAppleDialogCode(value);
  if (Object.hasOwn(stringDetails, key)) return includes(stringDetails[key], value);
  return (
    ['alreadyOwned', 'codeRequired', 'statePresent', 'dialogPresent', 'actionPresent', 'messagePresent'].includes(
      key,
    ) && typeof value === 'boolean'
  );
}

/** Reject unknown fields and arbitrary strings before a browser event reaches stdout. */
export function validateDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !allowedFields.has(key)) ||
    requiredFields.some((key) => !Object.hasOwn(input, key))
  )
    return undefined;
  if (
    input.schema !== 1 ||
    !validDiagnosticId(input.flowId) ||
    !Number.isSafeInteger(input.sequence) ||
    (input.sequence as number) < 1 ||
    (input.sequence as number) > 1_000_000 ||
    !Number.isSafeInteger(input.at) ||
    (input.at as number) < 0 ||
    !includes(diagnosticFlows, input.flow) ||
    !includes(diagnosticStages, input.stage) ||
    !includes(diagnosticOutcomes, input.outcome)
  )
    return undefined;
  for (const key of detailFields) {
    if (Object.hasOwn(input, key) && !validDetail(key, input[key])) return undefined;
  }
  // Construct a fresh object: never spread a request, response, Error, or headers.
  const event = {
    schema: 1,
    flowId: input.flowId,
    sequence: input.sequence,
    flow: input.flow,
    stage: input.stage,
    outcome: input.outcome,
    at: input.at,
  } as DiagnosticEvent;
  for (const key of detailFields) {
    if (Object.hasOwn(input, key)) (event as unknown as Record<string, unknown>)[key] = input[key];
  }
  return event;
}

function safeDetails(details: DiagnosticDetails): DiagnosticDetails {
  const result: Record<string, unknown> = {};
  for (const key of detailFields) {
    if (validDetail(key, details[key])) result[key] = details[key];
  }
  return result as DiagnosticDetails;
}

export interface DiagnosticMetadata {
  requestId?: string;
  taskId?: string;
  taskState?: 'pending' | 'downloading' | 'paused' | 'injecting' | 'completed' | 'failed' | 'deleted';
}

export function writeDiagnostic(
  source: 'browser' | 'backend',
  event: DiagnosticEvent,
  metadata: DiagnosticMetadata = {},
): void {
  try {
    const validated = validateDiagnosticEvent(event);
    if (!validated) return;
    const safe: Record<string, unknown> = {};
    if (validDiagnosticId(metadata.requestId)) safe.requestId = metadata.requestId;
    if (validDiagnosticId(metadata.taskId)) safe.taskId = metadata.taskId;
    if (
      ['pending', 'downloading', 'paused', 'injecting', 'completed', 'failed', 'deleted'].includes(
        metadata.taskState || '',
      )
    )
      safe.taskState = metadata.taskState;
    console.log(JSON.stringify({ event: 'asspp.diagnostic', source, ...validated, ...safe }));
  } catch {
    // Observability must never change an application result or retry its work.
  }
}

export interface ServerDiagnostic {
  readonly flowId: string;
  readonly requestId: string;
  event(
    stage: DiagnosticEvent['stage'],
    outcome: DiagnosticEvent['outcome'],
    details?: DiagnosticDetails,
    metadata?: DiagnosticMetadata,
  ): void;
  result(details: DiagnosticDetails): void;
}

export function createServerDiagnostic(
  flow: DiagnosticEvent['flow'],
  flowId?: string,
  requestId?: string,
): ServerDiagnostic {
  const id = validDiagnosticId(flowId) ? flowId.toLowerCase() : randomUUID();
  const request = validDiagnosticId(requestId) ? requestId.toLowerCase() : randomUUID();
  let sequence = 0;
  return {
    flowId: id,
    requestId: request,
    event(stage, outcome, details = {}, metadata = {}) {
      writeDiagnostic(
        'backend',
        {
          schema: 1,
          flowId: id,
          sequence: ++sequence,
          flow,
          stage,
          outcome,
          at: Date.now(),
          ...safeDetails(details),
        },
        { ...metadata, requestId: request },
      );
    },
    result() {},
  };
}

/** Log an HTTP operation once on entry and once on completion or disconnection. */
export function observeRequest(
  req: Request,
  res: Response,
  flow: DiagnosticEvent['flow'],
  stage: DiagnosticEvent['stage'],
  endpoint: DiagnosticDetails['endpoint'],
): ServerDiagnostic {
  const trace = createServerDiagnostic(flow, req.get('X-Asspp-Flow-Id'));
  const started = Date.now();
  let finished = false;
  let result: DiagnosticDetails = {};
  trace.result = (details) => {
    result = { ...result, ...safeDetails(details) };
  };
  res.set('X-Asspp-Flow-Id', trace.flowId);
  res.set('X-Asspp-Request-Id', trace.requestId);
  trace.event(stage, 'start', { endpoint });
  res.once('finish', () => {
    if (finished) return;
    finished = true;
    const outcome =
      res.statusCode < 400
        ? 'success'
        : [400, 401, 403, 404, 409, 413, 429].includes(res.statusCode)
          ? 'blocked'
          : 'failure';
    trace.event(stage, outcome, {
      endpoint,
      ...result,
      httpStatus: res.statusCode,
      durationMs: Math.min(Date.now() - started, 604_800_000),
      ...(res.statusCode >= 400 && !result.reason ? { reason: 'http_error' as const } : {}),
    });
  });
  res.once('close', () => {
    if (finished) return;
    finished = true;
    trace.event(stage, 'cancelled', {
      endpoint,
      reason: 'cancelled',
      durationMs: Math.min(Date.now() - started, 604_800_000),
    });
  });
  return trace;
}
