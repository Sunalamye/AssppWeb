import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import searchRoutes from '../src/routes/search.js';

const app = express();
app.use('/api', searchRoutes);

function directRequest(endpoint: string) {
  const route = (searchRoutes as any).stack.find((layer: any) => layer.route?.path === `/${endpoint}`).route;
  const req = { query: { term: 'fixture' }, get: () => undefined };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    body: undefined as unknown,
    set: vi.fn().mockReturnThis(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(function (this: any, body: unknown) {
      this.body = body;
      this.writableEnded = true;
      this.emit('finish');
      return this;
    }),
  });
  return { res, run: () => route.stack[0].handle(req, res) as Promise<void> };
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['search', 'lookup'])('public catalog %s', (endpoint) => {
  it.each([429, 500])('does not turn an upstream %i into empty catalog success', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ errorMessage: 'private-upstream-message' }, { status }),
    );
    const response = await request(app).get(`/api/${endpoint}?term=private-query`);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: endpoint === 'search' ? 'Search request failed' : 'Lookup request failed' });
    const logs = vi.mocked(console.log).mock.calls.flat().join(' ');
    expect(logs).not.toMatch(/private-upstream-message|private-query/);
    expect(logs).not.toContain('"outcome":"success"');
    expect(logs).toContain('"reason":"http_error"');
  });

  it.each([{}, { resultCount: 1, results: [] }, { resultCount: 1, results: [null] }])(
    'rejects a malformed catalog wrapper: %j',
    async (body) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
      const response = await request(app).get(`/api/${endpoint}?term=fixture`);
      expect(response.status).toBe(502);
      expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('"reason":"invalid_response"');
    },
  );

  it('preserves a genuine empty result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ resultCount: 0, results: [] }));
    const response = await request(app).get(`/api/${endpoint}?term=fixture`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(endpoint === 'search' ? [] : null);
  });

  it('maps a successful result using the shared Software field names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        resultCount: 1,
        results: [
          { trackId: 123, bundleId: 'example.fixture', trackName: 'Fixture', currentVersionReleaseDate: 'today' },
        ],
      }),
    );
    const response = await request(app).get(`/api/${endpoint}?term=fixture`);
    const software = {
      id: 123,
      bundleID: 'example.fixture',
      name: 'Fixture',
      releaseDate: 'today',
      screenshotUrls: [],
    };
    expect(response.status).toBe(200);
    expect(response.body).toEqual(endpoint === 'search' ? [software] : software);
  });

  it('keeps its deadline active while the upstream body stalls after headers', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let rejectBody!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      signal = options?.signal as AbortSignal | undefined;
      const body = new Promise((_resolve, reject) => {
        rejectBody = reject;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return { ok: true, status: 200, json: () => body } as Response;
    });
    const { res, run } = directRequest(endpoint);
    const running = run();
    await vi.advanceTimersByTimeAsync(15_000);
    const expired = signal?.aborted;
    // Let the old implementation settle too, so a regression fails immediately.
    rejectBody(new Error('fixture cleanup'));
    await running;
    expect(expired).toBe(true);
    expect(res.statusCode).toBe(504);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('"reason":"timeout"');
  });

  it('cancels upstream work when the caller disconnects without writing another response', async () => {
    let signal: AbortSignal | undefined;
    let rejectFetch!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      signal = options?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        rejectFetch = reject;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const { res, run } = directRequest(endpoint);
    const running = run();
    res.destroyed = true;
    res.emit('close');
    const cancelled = signal?.aborted;
    rejectFetch(new Error('fixture cleanup'));
    await running;
    expect(cancelled).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('"outcome":"cancelled"');
  });
});
