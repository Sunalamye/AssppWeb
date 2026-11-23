import { Router } from 'express';

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
  res.set('Cache-Control', 'no-store');
  if (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json(failure('INVALID_REQUEST', 'Device verification requires a same-site JSON request.'));
    return;
  }

  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
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
    res.status(400).json(failure('INVALID_REQUEST', 'Invalid device verification fields.'));
    return;
  }
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > maxBodyBytes) {
    res.status(413).json(failure('REQUEST_TOO_LARGE', 'Device verification request is too large.'));
    return;
  }
  if (activeRequests >= 4) {
    res.set('Retry-After', '3').status(429).json(failure('BUSY', 'Device verification is busy. Try again shortly.'));
    return;
  }

  activeRequests++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const response = await fetch(`${helperURL}/v1/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d{1,3}$/.test(retryAfter)) res.set('Retry-After', retryAfter);
    res.status(response.status).json(output);
  } catch {
    // Native errors may contain opaque device state. Do not log or reflect
    // exceptions, request bodies, browser headers, or helper response bodies.
    if (!res.destroyed) {
      res.status(503).json(failure('HELPER_UNAVAILABLE', 'Device verification is unavailable. Please retry.'));
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
    activeRequests--;
  }
});

router.get('/store-proof/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const response = await fetch(`${helperURL}/health`, {
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    const body = (await response.json()) as { status?: unknown };
    const status = ['ready', 'loading', 'error'].includes(String(body.status)) ? body.status : 'error';
    res.status(status === 'ready' ? 200 : 503).json({ status });
  } catch {
    // The HTTP listener can start before the helper binds during a cold start.
    // Only an explicit helper failure is permanent; connection failures can be
    // retried by the browser within its bounded readiness deadline.
    res.status(503).json({ status: 'loading' });
  }
});

export default router;
