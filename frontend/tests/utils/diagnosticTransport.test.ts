import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticEvent } from '../../src/utils/diagnostics';

vi.unmock('../../src/utils/diagnosticTransport');
vi.mock('../../src/api/client', () => ({ authHeaders: () => ({ 'X-Access-Token': 'test-access-token' }) }));

const event: DiagnosticEvent = {
  schema: 1,
  flowId: 'b7d29fb5-64fe-45c9-9cf4-182031b45a89',
  sequence: 1,
  flow: 'license',
  stage: 'purchase',
  outcome: 'start',
  at: 1795488000000,
};

describe('diagnostic delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses an authenticated bounded request without exposing the access token in its body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { enqueueDiagnosticEvent } = await import('../../src/utils/diagnosticTransport');
    enqueueDiagnosticEvent(event);
    await vi.runAllTimersAsync();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/diagnostics');
    expect(options.keepalive).toBe(true);
    expect(options.headers['X-Access-Token']).toBe('test-access-token');
    expect(options.body).not.toContain('test-access-token');
    expect(JSON.parse(options.body)).toEqual(event);
  });

  it('does not retry actions or throw when logging is rejected or disconnected', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const { enqueueDiagnosticEvent } = await import('../../src/utils/diagnosticTransport');
    expect(() => {
      enqueueDiagnosticEvent(event);
      enqueueDiagnosticEvent({ ...event, sequence: 2 });
    }).not.toThrow();
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('limits simultaneous uploads and aborts stalled logging requests', async () => {
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { enqueueDiagnosticEvent } = await import('../../src/utils/diagnosticTransport');
    for (let sequence = 1; sequence <= 3; sequence++) enqueueDiagnosticEvent({ ...event, sequence });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
