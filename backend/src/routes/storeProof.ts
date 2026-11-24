import { Router } from 'express';
import { observeRequest, validDiagnosticErrorCode } from '../utils/diagnostics.js';
import type { DiagnosticEvent, DiagnosticDetails } from '../utils/diagnostics.js';

const router = Router();
const helperURL = 'http://127.0.0.1:8081';
const maxBodyBytes = 4 * 1024 * 1024;
const maxResponseBytes = 4 * 1024 * 1024;
const operationFields: Record<string, readonly string[]> = {
  bootstrap: ['operation', 'deviceId', 'endpoint', 'state'],
  proof: ['operation', 'deviceId', 'endpoint', 'state'],
  'provision-start': ['operation', 'deviceId', 'state', 'challenge'],
  'provision-finish': ['operation', 'deviceId', 'pending', 'settingInfo', 'transportKey', 'keybag'],
  kbsync: ['operation', 'deviceId', 'dsid'],
};
let activeRequests = 0;

function failure(code: string, message: string) {
  return { error: { code, message } };
}

// The helper accepts only device-proof material. Apple credentials, account
// cookies, SAP signers and request bodies never cross this HTTP boundary.
router.post('/store-proof', async (req, res) => {
  const stages: Record<string, DiagnosticEvent['stage']> = {
    bootstrap: 'bootstrap',
    proof: 'proof',
    'provision-start': 'provision_start',
    'provision-finish': 'provision_finish',
    kbsync: 'kbsync',
  };
  const requestedOperation = typeof req.body?.operation === 'string' ? req.body.operation : '';
  const stage = Object.hasOwn(stages, requestedOperation) ? stages[requestedOperation] : 'proof';
  const trace = observeRequest(req, res, requestedOperation === 'kbsync' ? 'download' : 'login', stage, 'helper');
  res.set('Cache-Control', 'no-store');
  if (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site') {
    trace.result({ reason: 'invalid_request', errorCode: 'INVALID_REQUEST' });
    res.status(403).json(failure('INVALID_REQUEST', 'Device verification requires a same-site JSON request.'));
    return;
  }

  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    trace.result({ reason: 'invalid_request', errorCode: 'INVALID_REQUEST' });
    res.status(400).json(failure('INVALID_REQUEST', 'Invalid device verification request.'));
    return;
  }
  const input = body as Record<string, unknown>;
  const operation = input.operation;
  const fields =
    typeof operation === 'string' && Object.hasOwn(operationFields, operation) ? operationFields[operation] : undefined;
  if (
    !fields ||
    Object.keys(input).some((key) => !fields.includes(key)) ||
    Object.values(input).some((value) => typeof value !== 'string') ||
    typeof input.deviceId !== 'string' ||
    !/^[a-fA-F0-9]{12}$/.test(input.deviceId)
  ) {
    trace.result({ reason: 'invalid_request', errorCode: 'INVALID_REQUEST' });
    res.status(400).json(failure('INVALID_REQUEST', 'Invalid device verification fields.'));
    return;
  }
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > maxBodyBytes) {
    trace.result({ reason: 'invalid_request', errorCode: 'REQUEST_TOO_LARGE' });
    res.status(413).json(failure('REQUEST_TOO_LARGE', 'Device verification request is too large.'));
    return;
  }
  if (activeRequests >= 4) {
    trace.result({ reason: 'busy', errorCode: 'BUSY' });
    res.set('Retry-After', '3').status(429).json(failure('BUSY', 'Device verification is busy. Try again shortly.'));
    return;
  }

  activeRequests++;
  trace.event(stage, 'transition', { statePresent: typeof input.state === 'string', endpoint: 'helper' });
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 95_000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const response = await fetch(`${helperURL}/v1/proof`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Asspp-Flow-Id': trace.flowId,
        'X-Asspp-Request-Id': trace.requestId,
      },
      body: encoded,
      signal: controller.signal,
      redirect: 'error',
    });
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxResponseBytes) throw new Error('Helper response exceeded limit');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing helper response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error('Helper response exceeded limit');
      }
      chunks.push(value);
    }
    const output: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const result = output as { mode?: unknown; error?: { code?: unknown } };
      const code = result.error?.code;
      if (validDiagnosticErrorCode(code)) {
        const reasons: Record<string, DiagnosticDetails['reason']> = {
          PROVISIONING_EXPIRED: 'expired',
          PROVISIONING_BUSY: 'busy',
          BUSY: 'busy',
          NOT_PROVISIONED: 'not_provisioned',
          PROOF_TIMEOUT: 'timeout',
          HELPER_LOADING: 'not_ready',
          HELPER_UNAVAILABLE: 'unavailable',
          INVALID_REQUEST: 'invalid_request',
          REQUEST_TOO_LARGE: 'invalid_request',
        };
        trace.result({ errorCode: code, reason: reasons[code] ?? 'unknown' });
      }
      if (result.mode === 'store' || result.mode === 'bootstrap') trace.result({ mode: result.mode });
    }
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d{1,3}$/.test(retryAfter)) res.set('Retry-After', retryAfter);
    res.status(response.status).json(output);
  } catch {
    // Native errors may contain opaque device state. Do not log or reflect
    // exceptions, request bodies, browser headers, or helper response bodies.
    if (!res.destroyed) {
      trace.result({
        reason: timedOut ? 'timeout' : 'unavailable',
        errorCode: timedOut ? 'PROOF_TIMEOUT' : 'HELPER_UNAVAILABLE',
      });
      res
        .status(timedOut ? 504 : 503)
        .json(
          failure(
            timedOut ? 'PROOF_TIMEOUT' : 'HELPER_UNAVAILABLE',
            'Device verification is unavailable. Please retry.',
          ),
        );
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
    // A rejected Content-Length can leave the body unread; release its socket.
    controller.abort();
    activeRequests--;
  }
});

router.get('/store-proof/health', async (req, res) => {
  const trace = observeRequest(req, res, 'login', 'bootstrap', 'helper');
  res.set('Cache-Control', 'no-store');
  try {
    const response = await fetch(`${helperURL}/health`, {
      headers: {
        'X-Asspp-Flow-Id': trace.flowId,
        'X-Asspp-Request-Id': trace.requestId,
      },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    const body = (await response.json()) as { status?: unknown };
    const status = ['ready', 'loading', 'error'].includes(String(body.status)) ? body.status : 'error';
    if (status !== 'ready') trace.result({ reason: status === 'loading' ? 'not_ready' : 'unavailable' });
    res.status(status === 'ready' ? 200 : 503).json({ status });
  } catch {
    trace.result({ reason: 'not_ready' });
    // The HTTP listener can start before the helper binds during a cold start.
    // Only an explicit helper failure is permanent; connection failures can be
    // retried by the browser within its bounded readiness deadline.
    res.status(503).json({ status: 'loading' });
  }
});

export default router;
