import { create } from 'zustand';
import { searchApps, lookupApp } from '../api/search';
import type { Software } from '../types';

interface SearchState {
  term: string;
  country: string;
  entity: string;
  results: Software[];
  resultsCountry: string | null;
  loading: boolean;
  error: string | null;
  setSearchParam: (param: Partial<Pick<SearchState, 'term' | 'country' | 'entity'>>) => void;
  search: (term: string, country: string, entity: string) => Promise<void>;
  lookup: (bundleId: string, country: string) => Promise<void>;
  clear: () => void; // 新增：清空搜索状态的方法
}

export const useSearch = create<SearchState>((set) => {
  let generation = 0;
  return {
    term: '',
    country: '',
    entity: '',
    results: [],
    resultsCountry: null,
    loading: false,
    error: null,
    setSearchParam: (param) =>
      set((state) => {
        const changedFilter =
          (param.country !== undefined && param.country !== state.country) ||
          (param.entity !== undefined && param.entity !== state.entity);
        if (!changedFilter) return param;
        generation++;
        return { ...param, results: [], resultsCountry: null, loading: false, error: null };
      }),
    search: async (term, country, entity) => {
      const request = ++generation;
      set({ loading: true, error: null, term, country, entity, results: [], resultsCountry: null });
      try {
        const apps = await searchApps(term, country, entity);
        if (request === generation) set({ results: apps, resultsCountry: country });
      } catch (e) {
        if (request === generation) {
          set({
            error: e instanceof Error ? e.message : 'Search failed',
            results: [],
            resultsCountry: null,
          });
        }
      } finally {
        if (request === generation) set({ loading: false });
      }
    },
    lookup: async (bundleId, country) => {
      const request = ++generation;
      set({ loading: true, error: null, country, results: [], resultsCountry: null });
      try {
        const app = await lookupApp(bundleId, country);
        if (request === generation) set({ results: app ? [app] : [], resultsCountry: country });
      } catch (e) {
        if (request === generation) {
          set({
            error: e instanceof Error ? e.message : 'Lookup failed',
            results: [],
            resultsCountry: null,
          });
        }
      } finally {
        if (request === generation) set({ loading: false });
      }
    },
    // Keep the chosen filters, but prevent an older request from restoring cleared results.
    clear: () => {
      generation++;
      set({ term: '', results: [], resultsCountry: null, error: null, loading: false });
    },
  };
});
