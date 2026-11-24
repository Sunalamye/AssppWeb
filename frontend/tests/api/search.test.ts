import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../../src/api/client';
import { lookupApp, searchApps } from '../../src/api/search';

vi.mock('../../src/api/client', () => ({ apiGet: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe('public App Store lookup identifiers', () => {
  it.each(['123456', ' 123456 ', '9007199254740993'])(
    'sends numeric App ID %s as id without numeric conversion',
    async (value) => {
      vi.mocked(apiGet).mockResolvedValue(null);
      await lookupApp(value, 'CN');
      const url = new URL(vi.mocked(apiGet).mock.calls[0][0], 'https://fixture.invalid');
      expect(url.pathname).toBe('/api/lookup');
      expect(url.searchParams.get('id')).toBe(value.trim());
      expect(url.searchParams.has('bundleId')).toBe(false);
      expect(url.searchParams.get('country')).toBe('CN');
      expect(apiGet).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['com.example.app', '123abc', '1e8', '123.45'])(
    'keeps a non-numeric identifier %s in bundleId',
    async (value) => {
      vi.mocked(apiGet).mockResolvedValue(null);
      await lookupApp(value, 'US');
      const url = new URL(vi.mocked(apiGet).mock.calls[0][0], 'https://fixture.invalid');
      expect(url.searchParams.get('bundleId')).toBe(value);
      expect(url.searchParams.has('id')).toBe(false);
      expect(url.searchParams.get('country')).toBe('US');
    },
  );

  it('preserves the explicit country and entity for ordinary search', async () => {
    vi.mocked(apiGet).mockResolvedValue([]);
    await searchApps('Example app', 'CN', 'iPad');
    const url = new URL(vi.mocked(apiGet).mock.calls[0][0], 'https://fixture.invalid');
    expect(url.pathname).toBe('/api/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      term: 'Example app',
      country: 'CN',
      entity: 'iPadSoftware',
      limit: '25',
    });
  });
});
