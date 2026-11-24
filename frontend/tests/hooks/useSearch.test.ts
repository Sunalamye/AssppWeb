import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearch } from '../../src/hooks/useSearch';
import { lookupApp, searchApps } from '../../src/api/search';
import type { Software } from '../../src/types';

vi.mock('../../src/api/search', () => ({ lookupApp: vi.fn(), searchApps: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const usApp = { id: 123, bundleID: 'example.us', name: 'US result' } as Software;
const cnApp = { id: 456, bundleID: 'example.cn', name: 'CN result' } as Software;

beforeEach(() => {
  vi.resetAllMocks();
  useSearch.getState().clear();
  useSearch.getState().setSearchParam({ country: 'US', entity: 'iPhone' });
});

describe('search result ownership', () => {
  it('clears completed results on country change without issuing another request', async () => {
    vi.mocked(searchApps).mockResolvedValue([usApp]);
    await useSearch.getState().search('app', 'US', 'iPhone');
    expect(useSearch.getState()).toMatchObject({ results: [usApp], resultsCountry: 'US' });
    useSearch.getState().setSearchParam({ country: 'US' });
    expect(useSearch.getState().results).toEqual([usApp]);
    useSearch.getState().setSearchParam({ country: 'CN' });
    expect(useSearch.getState()).toMatchObject({
      country: 'CN',
      results: [],
      resultsCountry: null,
      loading: false,
      error: null,
    });
    expect(searchApps).toHaveBeenCalledTimes(1);
  });

  it('ignores an in-flight result after its country is changed', async () => {
    const old = deferred<Software[]>();
    vi.mocked(searchApps).mockReturnValue(old.promise);
    const request = useSearch.getState().search('app', 'US', 'iPhone');
    useSearch.getState().setSearchParam({ country: 'CN' });
    old.resolve([usApp]);
    await request;
    expect(useSearch.getState()).toMatchObject({ country: 'CN', results: [], resultsCountry: null, loading: false });
    expect(searchApps).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('does not let an older %s settle the newer search', async (completion) => {
    const old = deferred<Software[]>();
    const next = deferred<Software[]>();
    vi.mocked(searchApps).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const oldRequest = useSearch.getState().search('old', 'US', 'iPhone');
    const nextRequest = useSearch.getState().search('new', 'CN', 'iPhone');
    if (completion === 'resolve') old.resolve([usApp]);
    else old.reject(new Error('stale failure'));
    await oldRequest;
    expect(useSearch.getState()).toMatchObject({ country: 'CN', term: 'new', loading: true, error: null, results: [] });
    next.resolve([cnApp]);
    await nextRequest;
    expect(useSearch.getState()).toMatchObject({ results: [cnApp], resultsCountry: 'CN', loading: false });
  });

  it('does not overwrite a newer successful result when the earlier request finishes last', async () => {
    const old = deferred<Software[]>();
    vi.mocked(searchApps).mockReturnValueOnce(old.promise).mockResolvedValueOnce([cnApp]);
    const oldRequest = useSearch.getState().search('old', 'US', 'iPhone');
    await useSearch.getState().search('new', 'CN', 'iPhone');
    old.resolve([usApp]);
    await oldRequest;
    expect(useSearch.getState()).toMatchObject({ results: [cnApp], resultsCountry: 'CN', country: 'CN' });
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps clear effective after a pending request later %ss',
    async (completion) => {
      const pending = deferred<Software[]>();
      vi.mocked(searchApps).mockReturnValue(pending.promise);
      const request = useSearch.getState().search('app', 'CN', 'iPad');
      useSearch.getState().clear();
      if (completion === 'resolve') pending.resolve([cnApp]);
      else pending.reject(new Error('stale failure'));
      await request;
      expect(useSearch.getState()).toMatchObject({
        term: '',
        country: 'CN',
        entity: 'iPad',
        results: [],
        resultsCountry: null,
        error: null,
        loading: false,
      });
    },
  );

  it('invalidates results when the device filter changes', async () => {
    vi.mocked(searchApps).mockResolvedValue([usApp]);
    await useSearch.getState().search('app', 'US', 'iPhone');
    useSearch.getState().setSearchParam({ entity: 'iPad' });
    expect(useSearch.getState()).toMatchObject({ entity: 'iPad', results: [], resultsCountry: null });
    expect(searchApps).toHaveBeenCalledTimes(1);
  });

  it('shares latest-request ownership between lookup and search', async () => {
    const pending = deferred<Software | null>();
    vi.mocked(lookupApp).mockReturnValue(pending.promise);
    vi.mocked(searchApps).mockResolvedValue([usApp]);
    const lookup = useSearch.getState().lookup('456', 'CN');
    expect(useSearch.getState().country).toBe('CN');
    await useSearch.getState().search('app', 'US', 'iPhone');
    pending.resolve(cnApp);
    await lookup;
    expect(useSearch.getState()).toMatchObject({ country: 'US', results: [usApp], resultsCountry: 'US' });
  });

  it('associates a completed lookup with the requested country', async () => {
    vi.mocked(lookupApp).mockResolvedValue(cnApp);
    await useSearch.getState().lookup('456', 'CN');
    expect(useSearch.getState()).toMatchObject({ country: 'CN', results: [cnApp], resultsCountry: 'CN' });
  });
});
