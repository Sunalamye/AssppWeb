import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import storeProofRoutes from '../src/routes/storeProof.js';

function app() {
  const application = express();
  application.use(express.json({ limit: '6mb' }));
  application.use('/api', storeProofRoutes);
  return application;
}

const input = {
  operation: 'proof',
  deviceId: 'aabbccddeeff',
  state: 'synthetic-machine-state',
  endpoint: 'https://auth.itunes.apple.com/auth/v1/native',
};

afterEach(() => vi.restoreAllMocks());

describe('device proof HTTP boundary', () => {
  it('forwards only the typed device payload to loopback, never browser credentials or headers', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ headers: {}, state: 'updated' }));
    const response = await request(app())
      .post('/api/store-proof')
      .set('Cookie', 'apple-session=must-stay-local')
      .set('Authorization', 'Bearer browser-only')
      .set('X-Apple-ActionSignature', 'browser-sap-signature')
      .send(input);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.state).toBe('updated');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8081/v1/proof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
  });

  it.each(['password', 'appleId', 'cookies', 'passwordToken', 'code', 'headers', 'body', 'callbackURL'])(
    'rejects unexpected %s before contacting the helper',
    async (field) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const response = await request(app())
        .post('/api/store-proof')
        .send({ ...input, [field]: 'private' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_REQUEST');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...input, operation: 'toString' },
    { ...input, operation: 'fetch' },
    { ...input, deviceId: '../other-user' },
    { ...input, state: { password: 'private' } },
    [input],
  ])('rejects malformed operation, identity and nested input', async (body) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await request(app()).post('/api/store-proof').send(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-site JSON requests and oversized state', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const crossSite = await request(app()).post('/api/store-proof').set('Sec-Fetch-Site', 'cross-site').send(input);
    expect(crossSite.status).toBe(403);
    const oversized = await request(app())
      .post('/api/store-proof')
      .send({ ...input, state: 'x'.repeat(4 * 1024 * 1024) });
    expect(oversized.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps structured helper failures and retry timing without exposing native exceptions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { error: { code: 'BUSY', message: 'Device verification is busy.' } },
        { status: 429, headers: { 'Retry-After': '3' } },
      ),
    );
    const busy = await request(app()).post('/api/store-proof').send(input);
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('3');
    vi.mocked(fetch).mockRejectedValue(new Error('secret-state must never be reflected'));
    const unavailable = await request(app()).post('/api/store-proof').send(input);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('HELPER_UNAVAILABLE');
    expect(unavailable.text).not.toContain('secret-state');
  });

  it('returns only readiness from helper health', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'ready', state: 'do-not-reflect' }));
    const response = await request(app()).get('/api/store-proof/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('waits through the initial loopback connection race and preserves explicit preparation failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const starting = await request(app()).get('/api/store-proof/health');
    expect(starting.status).toBe(503);
    expect(starting.body).toEqual({ status: 'loading' });

    vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'error' }, { status: 503 }));
    const failed = await request(app()).get('/api/store-proof/health');
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ status: 'error' });
  });
});
