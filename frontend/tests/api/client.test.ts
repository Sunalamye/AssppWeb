import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, apiDelete } from '../../src/api/client';

describe('api/client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  describe('apiGet', () => {
    it('should make GET request and return JSON', async () => {
      const mockData = { results: [] };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response);

      const result = await apiGet('/api/test');
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith('/api/test', {
        headers: {},
        signal: expect.any(AbortSignal),
      });
    });

    it('should throw on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Not found'),
      } as Response);

      await expect(apiGet('/api/missing')).rejects.toThrow('Not found');
    });
  });

  describe('apiPost', () => {
    it('should make POST request with JSON body', async () => {
      const mockResponse = { id: '123' };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await apiPost('/api/test', { data: 'value' });
      expect(result).toEqual(mockResponse);
      expect(fetch).toHaveBeenCalledWith('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'value' }),
        signal: expect.any(AbortSignal),
      });
    });

    it('should handle POST without body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await apiPost('/api/test');
      expect(fetch).toHaveBeenCalledWith('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: undefined,
        signal: expect.any(AbortSignal),
      });
    });
  });

  describe('apiDelete', () => {
    it('should make DELETE request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
      } as Response);

      await apiDelete('/api/test/123');
      expect(fetch).toHaveBeenCalledWith('/api/test/123', {
        method: 'DELETE',
        headers: {},
        signal: expect.any(AbortSignal),
      });
    });

    it('should throw on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Server error'),
      } as Response);

      await expect(apiDelete('/api/test/123')).rejects.toThrow('Server error');
    });
  });

  it('carries flow headers and preserves the real access token', async () => {
    sessionStorage.setItem('auth-token', 'synthetic-access-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await apiPost('/api/downloads', {}, { 'X-Asspp-Flow-Id': 'synthetic-flow-id', 'X-Access-Token': 'wrong' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/downloads',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'X-Asspp-Flow-Id': 'synthetic-flow-id',
          'X-Access-Token': 'synthetic-access-token',
        },
      }),
    );
  });

  it('retains safe HTTP status details without adding a retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Unavailable',
    } as Response);
    await expect(apiPost('/api/downloads', {})).rejects.toMatchObject({
      message: 'Unavailable',
      diagnostics: { httpStatus: 503, reason: 'http_error' },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('aborts a stalled POST after 30 seconds without automatically repeating it', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const result = apiPost('/api/downloads', {}).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ name: 'TimeoutError', diagnostics: { reason: 'timeout' } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
