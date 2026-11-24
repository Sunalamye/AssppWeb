import { countryCodeMap } from '../apple/config';

const knownStorefrontIds = new Set(Object.values(countryCodeMap));

/** Only public catalog store IDs are permitted; never return a complete header. */
export function validStorefrontId(value: unknown): value is string {
  return typeof value === 'string' && knownStorefrontIds.has(value);
}

export function publicStorefrontId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().split(/[-,]/, 1)[0];
  return validStorefrontId(id) ? id : undefined;
}
