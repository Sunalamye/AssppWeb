import { authHeaders } from '../api/client';
import { parsePlist } from './plist';
import { errorDiagnosticDetails } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';

export interface BagOutput {
  authURL: string;
  downloadURL?: string;
  redownloadURL?: string;
  updateURL?: string;
}

export const defaultAuthURL = 'https://auth.itunes.apple.com/auth/v1/native';

// Native Store authentication must retain the exact bag path and query. The
// legacy finance endpoint alone needs its trailing slash (ipatool v2.8.1).
export function normalizeAuthURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (
    /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
    /^\/WebObjects\/MZFinance\.woa\/wa\/authenticate\/?$/.test(url.pathname)
  ) {
    url.pathname = '/WebObjects/MZFinance.woa/wa/authenticate/';
    return url.toString();
  }
  return rawURL;
}

// Fetches the bag via the backend proxy.
// The backend fetches it using Node.js native HTTPS.
// The bag response is public data (Apple service URLs, no credentials).
export async function fetchBag(deviceId: string, flow?: DiagnosticFlow): Promise<BagOutput> {
  const started = Date.now();
  flow?.log('bag', 'start', { endpoint: 'bag' });
  try {
    const resp = await fetch(`/api/bag?guid=${encodeURIComponent(deviceId)}`, {
      headers: { ...authHeaders(), ...(flow ? { 'X-Asspp-Flow-Id': flow.id } : {}) },
    });
    if (!resp.ok) {
      flow?.log('bag', 'failure', {
        endpoint: 'bag',
        httpStatus: resp.status,
        reason: 'http_error',
        durationMs: Date.now() - started,
      });
      flow?.log('bag', 'transition', { endpoint: 'native_auth', reason: 'fallback' });
      return { authURL: defaultAuthURL };
    }

    const xml = await resp.text();
    const dict = parsePlist(xml) as Record<string, any>;

    // authenticateAccount used to live inside the urlBag dict; newer bag
    // responses move it to the plist root, so prefer the root and fall back.
    const urlBag = dict.urlBag as Record<string, any> | undefined;
    const authURL =
      (dict.authenticateAccount as string | undefined) ?? (urlBag?.authenticateAccount as string | undefined);

    const downloadURLs = {
      downloadURL: (dict.volumeStoreDownloadProduct ?? urlBag?.volumeStoreDownloadProduct) as string | undefined,
      redownloadURL: (dict.redownloadProduct ?? urlBag?.redownloadProduct) as string | undefined,
      updateURL: (dict.updateProduct ?? urlBag?.updateProduct) as string | undefined,
    };

    if (!authURL) {
      flow?.log('bag', 'transition', { endpoint: 'native_auth', reason: 'fallback', httpStatus: resp.status });
      return { authURL: defaultAuthURL, ...downloadURLs };
    }

    flow?.log('bag', 'success', { endpoint: 'bag', httpStatus: resp.status, durationMs: Date.now() - started });
    return { authURL: normalizeAuthURL(authURL), ...downloadURLs };
  } catch (error) {
    flow?.log('bag', 'failure', {
      ...errorDiagnosticDetails(error),
      endpoint: 'bag',
      durationMs: Date.now() - started,
    });
    flow?.log('bag', 'transition', { endpoint: 'native_auth', reason: 'fallback' });
    return { authURL: defaultAuthURL };
  }
}
