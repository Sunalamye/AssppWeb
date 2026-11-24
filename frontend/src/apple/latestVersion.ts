import { appleRequest } from './request';
import { createDiagnosticFlow, errorDiagnosticDetails, attachDiagnosticId } from '../utils/diagnostics';
import { storeIdToCountry } from './config';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { Account, Software } from '../types';

// Public MDM catalog, as used by ipatool's iOS redownload recovery. Never send
// the account's cookies, DSID or password token to this metadata endpoint.
export async function lookupLatestVersion(
  account: Account,
  app: Software,
  flow: DiagnosticFlow = createDiagnosticFlow('versions'),
): Promise<string> {
  const started = Date.now();
  flow.log('version_lookup', 'start', { endpoint: 'public_version' });
  try {
    const result = await requestLatestVersion(account, app, flow);
    flow.log('version_lookup', 'success', { endpoint: 'public_version', durationMs: Date.now() - started });
    return result;
  } catch (error) {
    flow.log('version_lookup', 'failure', {
      ...errorDiagnosticDetails(error),
      endpoint: 'public_version',
      durationMs: Date.now() - started,
    });
    throw attachDiagnosticId(error, flow.id);
  }
}

async function requestLatestVersion(account: Account, app: Software, flow: DiagnosticFlow): Promise<string> {
  const country = storeIdToCountry(account.store.split('-')[0]);
  if (!country) throw new Error('Unknown account storefront');

  let attempt = 0;
  for (const platform of ['enterprisestore', 'iphone', 'ipad']) {
    flow.log('version_lookup', attempt ? 'retry' : 'transition', {
      endpoint: 'public_version',
      attempt: ++attempt,
      ...(attempt > 1 ? { reason: 'fallback' as const } : {}),
    });
    const query = new URLSearchParams({
      version: '2',
      id: String(app.id),
      p: 'mdm-lockup',
      caller: 'MDM',
      platform,
      cc: country.toLowerCase(),
      l: 'en',
    });
    const response = await appleRequest({
      method: 'GET',
      host: 'uclient-api.itunes.apple.com',
      path: `/WebObjects/MZStorePlatform.woa/wa/lookup?${query}`,
      diagnostics: flow,
    });
    flow.log('version_lookup', 'transition', { endpoint: 'public_version', httpStatus: response.status, attempt });
    if (response.status !== 200) throw new Error(`Catalog HTTP ${response.status}`);
    let result: unknown;
    try {
      result = JSON.parse(response.body);
    } catch {
      flow.log('version_lookup', 'blocked', { endpoint: 'public_version', reason: 'invalid_response' });
      throw new Error('Catalog returned invalid JSON');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Catalog returned invalid metadata');
    const item = (result as Record<string, any>).results?.[String(app.id)];
    if (!item || !Array.isArray(item.offers) || !item.offers.length) continue;
    if (app.bundleID && item.bundleId !== app.bundleID) {
      throw new Error('Catalog returned a different bundle identifier');
    }
    const offer = item.offers[0];
    const value = offer.version?.externalId ?? new URLSearchParams(offer.buyParams ?? '').get('appExtVrsId') ?? '';
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Error('Catalog returned an invalid version identifier');
    const version = String(value);
    if (/^[1-9]\d*$/.test(version)) return version;
    throw new Error('Catalog returned no valid iOS version identifier');
  }
  throw new Error('App not found in account storefront catalogs');
}
