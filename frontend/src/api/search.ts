import { apiGet } from './client';
import type { Software } from '../types';

export async function searchApps(
  term: string,
  country: string,
  entity: string,
  limit: number = 25,
): Promise<Software[]> {
  const params = new URLSearchParams({
    term,
    country,
    entity: entity === 'iPad' ? 'iPadSoftware' : 'software',
    limit: String(limit),
  });
  return apiGet<Software[]>(`/api/search?${params}`);
}

export async function lookupApp(identifier: string, country: string): Promise<Software | null> {
  const value = identifier.trim();
  const key = /^[0-9]+$/.test(value) ? 'id' : 'bundleId';
  const params = new URLSearchParams({ [key]: value, country });
  return apiGet<Software | null>(`/api/lookup?${params}`);
}
