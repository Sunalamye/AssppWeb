import i18n from '../i18n';
import { fetchBag } from './bag';
import { lookupLatestVersion } from './latestVersion';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
import { StoreProofClient } from './storeProof';
import { createDiagnosticFlow, errorDiagnosticDetails, attachDiagnosticId } from '../utils/diagnostics';
import { redownloadEndpoint, volumeStoreEndpoint } from './config';
import type { DiagnosticFlow, DiagnosticDetails } from '../utils/diagnostics';
import type { StoreDownloadEndpoint } from './config';
import type { AppleResponse } from './request';
import type { Account, Software } from '../types';

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly diagnostics?: DiagnosticDetails,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

// Only the observed empty/unavailable responses permit endpoint recovery.
// Authentication, license, and other structured failures must not be hidden.
export function needsDownloadFallback(dict: Record<string, any>): boolean {
  if (dict.songList?.length || dict.dialog || dict.action) return false;
  if (dict.failureType) return String(dict.failureType) === '5002';
  if (dict.status !== undefined && Number(dict.status) !== 0) return false;
  const message = String(dict.customerMessage ?? '')
    .trim()
    .toLowerCase();
  return !message || message === 'no longer available' || message.endsWith(' no longer available');
}

export function dispatchEndpoint(
  raw: string | undefined,
  kind: 'redownload' | 'update' | 'ent',
  deviceId: string,
): StoreDownloadEndpoint | undefined {
  if (!raw) return undefined;
  const path =
    kind === 'redownload'
      ? '/r/redownload'
      : kind === 'update'
        ? '/up/updateProduct'
        : '/WebObjects/DownloadDispatch.woa/wa/ent/download';
  // Match the advertised endpoint exactly; URL parsing would normalize encoded
  // dot segments, backslashes and empty queries before we could reject them.
  if (raw !== `https://downloaddispatch.itunes.apple.com${path}`) return undefined;
  return {
    host: 'downloaddispatch.itunes.apple.com',
    path: `${path}?guid=${encodeURIComponent(deviceId)}`,
    externalVersionIdKey: kind === 'ent' ? 'externalVersionId' : 'appExtVrsId',
  };
}

// Errors identify the endpoint without exposing bodies, queries, or account values.
function responseDict(response: AppleResponse, endpoint: StoreDownloadEndpoint): Record<string, any> {
  if (response.status === 200) {
    try {
      const dict = parsePlist(response.body);
      if (dict && typeof dict === 'object' && !Array.isArray(dict)) return normalizeDownloadFailure(dict);
    } catch {
      // Report the same safe diagnostic for every malformed response.
    }
  }
  const kind = response.body.trim() ? 'invalid plist' : 'empty response';
  const location = endpoint.host + endpoint.path.split('?')[0];
  throw new DownloadError(`Apple download: HTTP ${response.status}; ${kind}; ${location}`, undefined, {
    httpStatus: response.status,
    reason: response.body.trim() ? 'invalid_plist' : 'empty_response',
  });
}

function normalizeDownloadFailure(dict: Record<string, any>): Record<string, any> {
  const failureType = String(dict.failureType || (!dict.songList?.length && dict.metrics?.messageCode) || '').trim();
  if (['2034', '2042', '1008'].includes(failureType)) return { ...dict, failureType: '2034' };
  if (dict.songList?.length) return failureType ? { ...dict, failureType } : dict;
  const message = String(dict.customerMessage ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (['sign in to the itunes store', 'sign-in required'].includes(message)) {
    return { ...dict, failureType: '2034' };
  }
  const dialogMessage = String(dict.dialog?.message ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const dialogExplanation = String(dict.dialog?.explanation ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const unavailable = 'redownload unavailable with this apple account';
  if (
    message === unavailable ||
    (dialogMessage === unavailable &&
      dialogExplanation ===
        'this redownload is not available for this apple account either because it was bought by a different user or the item was refunded or cancelled.')
  )
    return { ...dict, failureType: '9610' };
  return failureType ? { ...dict, failureType } : dict;
}

function requireItems(dict: Record<string, any>): void {
  const code = String(dict.failureType ?? '');
  if (code) {
    if (['2034', '2042'].includes(code) || dict.customerMessage === 'Your password has changed.') {
      throw new DownloadError(i18n.t('errors.download.passwordExpired'), code);
    }
    if (code === '9610') throw new DownloadError(i18n.t('errors.download.licenseRequired'), code);
    throw new DownloadError(`${dict.customerMessage || 'Apple download failed'} (${code})`, code);
  }
  if (dict.customerMessage) throw new DownloadError(String(dict.customerMessage));
  if (dict.dialog || dict.action || (dict.status !== undefined && Number(dict.status) !== 0)) {
    const message = dict.dialog?.explanation ?? dict.dialog?.message;
    throw new DownloadError(
      typeof message === 'string' && message ? message : 'Apple rejected the download request',
      undefined,
      { reason: 'access_denied' },
    );
  }
  if (!Array.isArray(dict.songList) || !dict.songList.length) {
    throw new DownloadError(dict.customerMessage || i18n.t('errors.download.noItems'));
  }
}

function validateDownloadItem(dict: Record<string, any>, app: Software, version?: string): void {
  const metadata = dict.songList[0]?.metadata;
  if (
    dict.songList.length !== 1 ||
    !metadata ||
    String(metadata.itemId) !== String(app.id) ||
    (version && String(metadata.softwareVersionExternalIdentifier) !== version) ||
    !metadata.softwareVersionBundleId ||
    (app.bundleID && metadata.softwareVersionBundleId !== app.bundleID)
  ) {
    throw new DownloadError(i18n.t('errors.download.unexpectedItem'), undefined, { reason: 'version_mismatch' });
  }
}

// Only send account tokens and device proofs to the exact commerce routes we use.
function approvedDownloadURL(endpoint: StoreDownloadEndpoint, deviceId: string): string {
  const value = `https://${endpoint.host}${endpoint.path}`;
  const url = new URL(value);
  const query = [...url.searchParams];
  const allowedPath =
    url.hostname === 'downloaddispatch.itunes.apple.com'
      ? ['/r/redownload', '/up/updateProduct', '/WebObjects/DownloadDispatch.woa/wa/ent/download'].includes(
          url.pathname,
        )
      : /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
        url.pathname === '/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    value.includes('#') ||
    !allowedPath ||
    query.length !== 1 ||
    query[0][0] !== 'guid' ||
    query[0][1] !== deviceId ||
    value !== `${url.origin}${url.pathname}?guid=${encodeURIComponent(deviceId)}`
  ) {
    throw new DownloadError('Invalid Apple download endpoint');
  }
  return value;
}

function downloadSerial(deviceId: string): string {
  const hardwareID = deviceId.match(/../g)!.map((byte) => parseInt(byte, 16));
  return btoa(String.fromCharCode(0x54, 0xc8, 0xb0, 0xa9, 0x88, ...hardwareID.slice(2)));
}

/** Shared protocol for downloads, version lists, and pinned version metadata. */
export async function downloadProduct(
  account: Account,
  app: Software,
  versionId?: string,
  flow: DiagnosticFlow = createDiagnosticFlow('download'),
) {
  const started = Date.now();
  flow.log('download_product', 'start');
  try {
    const result = await requestDownloadProduct(account, app, versionId, flow);
    flow.log('download_product', 'success', { durationMs: Date.now() - started });
    return result;
  } catch (error) {
    flow.log('download_product', 'failure', { ...errorDiagnosticDetails(error), durationMs: Date.now() - started });
    throw attachDiagnosticId(error, flow.id);
  }
}

async function requestDownloadProduct(
  account: Account,
  app: Software,
  versionId: string | undefined,
  flow: DiagnosticFlow,
) {
  if (!/^[a-fA-F0-9]{12}$/.test(account.deviceIdentifier))
    throw new DownloadError('Invalid account device identifier', undefined, { reason: 'invalid_request' });
  if (!/^[1-9]\d*$/.test(account.directoryServicesIdentifier) || !account.passwordToken) {
    throw new DownloadError(i18n.t('errors.download.passwordExpired'), '2034');
  }
  if (versionId && !/^[1-9]\d*$/.test(versionId))
    throw new DownloadError('Invalid external version identifier', undefined, { reason: 'invalid_request' });

  const proof = new StoreProofClient(account.deviceIdentifier, flow);
  let cookies = [...account.cookies];
  const storeFront = account.storeFront || (account.store.includes('-') ? account.store : `${account.store}-1`);
  const send = async (
    endpoint: StoreDownloadEndpoint,
    version?: string,
    entitlement = false,
  ): Promise<AppleResponse> => {
    const url = approvedDownloadURL(endpoint, account.deviceIdentifier);
    const endpointKind = endpoint.path.startsWith('/r/redownload')
      ? 'redownload'
      : endpoint.path.startsWith('/up/updateProduct')
        ? 'update'
        : entitlement
          ? 'ent_download'
          : 'volume_download';
    flow.log('download_product', 'transition', { endpoint: endpointKind });
    const payload: Record<string, unknown> = {
      creditDisplay: '',
      guid: account.deviceIdentifier,
      salableAdamId: entitlement ? String(app.id) : app.id,
      serialNumber: entitlement ? downloadSerial(account.deviceIdentifier) : '0',
    };
    if (version) payload[endpoint.externalVersionIdKey] = version;
    if (entitlement) payload.kbsync = await proof.kbsync(account.directoryServicesIdentifier);
    const headers = await proof.proof(url);
    const response = await appleRequest({
      method: 'POST',
      host: endpoint.host,
      path: endpoint.path,
      headers: {
        ...headers,
        // This is the wire format used by Configurator's entitlement endpoint:
        // an XML plist body with the form content-type, matching ipatool.
        'Content-Type': entitlement ? 'application/x-www-form-urlencoded; charset=utf-8' : 'application/x-apple-plist',
        'iCloud-DSID': account.directoryServicesIdentifier,
        'X-Dsid': account.directoryServicesIdentifier,
        'X-Apple-Store-Front': storeFront,
        'X-Token': account.passwordToken,
      },
      body: buildPlist(payload),
      cookies,
      diagnostics: flow,
    });
    cookies = extractAndMergeCookies(response.rawHeaders, cookies);
    flow.log('download_product', 'transition', { endpoint: endpointKind, httpStatus: response.status });
    // Tokens and URL-bound proofs must not be replayed to a redirect target.
    // A later request resolves its route from a fresh bag instead.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      flow.log('download_product', 'blocked', {
        endpoint: endpointKind,
        httpStatus: response.status,
        reason: 'redirect',
      });
      throw new DownloadError('Apple download redirected; re-authenticate the account before retrying', '2034');
    }
    if (response.headers['x-apple-amd-action']) {
      flow.log('download_product', 'blocked', {
        endpoint: endpointKind,
        httpStatus: response.status,
        reason: 'device_verification',
      });
      throw new DownloadError(i18n.t('errors.download.passwordExpired'), '2034');
    }
    return response;
  };

  const bag = await fetchBag(account.deviceIdentifier, flow);
  let pinnedVersion = versionId;
  const pinVersion = async () => {
    if (!pinnedVersion) {
      try {
        pinnedVersion = await lookupLatestVersion(account, app, flow);
      } catch {
        throw new DownloadError(i18n.t('errors.download.versionLookupFailed'), undefined, { reason: 'not_found' });
      }
    } else {
      flow.log('version_lookup', 'transition', { reason: 'cache_hit' });
    }
    return pinnedVersion;
  };

  // Modern bags advertise ent/download. Use the same account/GUID-bound KBSync,
  // complete storefront, and fresh Store AMD proof as Configurator.
  if (bag.downloadURL) {
    const entitlement = dispatchEndpoint(bag.downloadURL, 'ent', account.deviceIdentifier);
    if (!entitlement) throw new DownloadError('Invalid entitlement download endpoint in Apple bag');
    const response = await send(entitlement, await pinVersion(), true);
    const recoverableHTTP = [204, 404, 500, 502, 503, 504].includes(response.status) && !response.body.trim();
    if (!recoverableHTTP) {
      const dict = responseDict(response, entitlement);
      if (!needsDownloadFallback(dict)) {
        requireItems(dict);
        validateDownloadItem(dict, app, pinnedVersion);
        if (!dict.songList[0].URL) throw new DownloadError(i18n.t('errors.download.missingUrl'));
        return { dict, updatedCookies: cookies };
      }
    }
    flow.log('download_product', 'retry', {
      endpoint: 'volume_download',
      httpStatus: response.status,
      reason: 'fallback',
    });
  }

  // Keep the bounded legacy chain for apps that the entitlement endpoint cannot
  // serve. Explicit account/license errors above never become endpoint retries.
  const primary = volumeStoreEndpoint(account.pod, account.deviceIdentifier);
  let dict = responseDict(await send(primary, pinnedVersion), primary);
  if (!needsDownloadFallback(dict)) {
    requireItems(dict);
    validateDownloadItem(dict, app, pinnedVersion);
    return { dict, updatedCookies: cookies };
  }

  // An unpinned dispatch request may return HTTP 500 or the tvOS build.
  await pinVersion();
  flow.log('download_product', 'retry', { endpoint: 'redownload', reason: 'fallback' });
  const redownload =
    dispatchEndpoint(bag.redownloadURL, 'redownload', account.deviceIdentifier) ??
    redownloadEndpoint(account.deviceIdentifier);
  const response = await send(redownload, pinnedVersion);
  const emptyServerError = response.status === 500 && !response.body.trim();
  if (!emptyServerError) dict = responseDict(response, redownload);
  const recoverable =
    !emptyServerError && needsDownloadFallback(dict) && (Boolean(dict.failureType) || Boolean(dict.customerMessage));

  const update = dispatchEndpoint(bag.updateURL, 'update', account.deviceIdentifier);
  if (update && (emptyServerError || recoverable)) {
    flow.log('download_product', 'retry', { endpoint: 'update', httpStatus: response.status, reason: 'fallback' });
    dict = responseDict(await send(update, pinnedVersion), update);
  } else if (emptyServerError) {
    responseDict(response, redownload); // Preserve the HTTP failure, not an XML parser error.
  }
  requireItems(dict);
  validateDownloadItem(dict, app, pinnedVersion);
  return { dict, updatedCookies: cookies };
}
