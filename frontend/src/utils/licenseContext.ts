import { validStorefrontId } from './storefront';

// Keep only the public store ID for this failed operation. Error objects must
// never retain account snapshots, credentials, or complete storefront headers.
const errorStorefronts = new WeakMap<object, string | undefined>();

export function rememberLicenseStorefront<T>(error: T, storefrontId: unknown): T {
  if (error && typeof error === 'object') {
    errorStorefronts.set(error, validStorefrontId(storefrontId) ? storefrontId : undefined);
  }
  return error;
}

export function licenseStorefrontForError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return errorStorefronts.get(error);
}
