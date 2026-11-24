import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appleRequest } from '../../src/apple/request';
import {
  clearDiagnosticEvents,
  createDiagnosticFlow,
  getDiagnosticEvents,
  getDiagnosticId,
} from '../../src/utils/diagnostics';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), initialize: vi.fn() }));
vi.mock('../../src/apple/libcurl-init', () => ({ libcurl: { fetch: mocks.fetch }, initLibcurl: mocks.initialize }));

describe('Apple request observability and deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue(undefined);
    clearDiagnosticEvents();
  });
  afterEach(() => vi.useRealTimers());

  it('records HTTP facts in the same flow without forwarding diagnostic metadata or logging credentials', async () => {
    mocks.fetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      raw_headers: [['set-cookie', 'PRIVATE_COOKIE']],
      text: async () => 'PRIVATE_RESPONSE',
    });
    const flow = createDiagnosticFlow('license');
    const response = await appleRequest({
      host: 'p47-buy.itunes.apple.com',
      path: '/WebObjects/MZFinance.woa/wa/buyProduct',
      method: 'POST',
      headers: { 'X-Token': 'PRIVATE_TOKEN' },
      body: 'PRIVATE_PASSWORD',
      diagnostics: flow,
    });
    expect(response.body).toBe('PRIVATE_RESPONSE');
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://p47-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct');
    expect(options.headers['X-Token']).toBe('PRIVATE_TOKEN');
    expect(options.headers).not.toHaveProperty('X-Asspp-Flow-Id');
    expect(options).not.toHaveProperty('diagnostics');
    expect(options.redirect).toBe('manual');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const events = getDiagnosticEvents();
    expect(events.every((event) => event.flowId === flow.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      stage: 'apple_request',
      outcome: 'transition',
      httpStatus: 200,
      endpoint: 'purchase',
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });

  it('returns non-200 responses to the protocol state machine while recording the HTTP failure', async () => {
    mocks.fetch.mockResolvedValue({ status: 500, statusText: '', raw_headers: [], text: async () => '' });
    await expect(
      appleRequest({ host: 'auth.itunes.apple.com', path: '/auth/v1/native', method: 'POST' }),
    ).resolves.toMatchObject({ status: 500 });
    expect(getDiagnosticEvents().at(-1)).toMatchObject({ outcome: 'failure', httpStatus: 500, reason: 'http_error' });
  });

  it('aborts a stuck request and records a timeout without replaying the request', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const flow = createDiagnosticFlow('license');
    const request = appleRequest({
      host: 'p47-buy.itunes.apple.com',
      path: '/WebObjects/MZFinance.woa/wa/buyProduct',
      method: 'POST',
      diagnostics: flow,
    });
    const failure = request.catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await failure;
    expect(error.name).toBe('TimeoutError');
    expect(getDiagnosticId(error)).toBe(flow.id);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(getDiagnosticEvents().at(-1)).toMatchObject({ reason: 'timeout', outcome: 'failure' });
  });
});
