import { libcurl, initLibcurl } from './libcurl-init';
import { buildCookieHeader } from './cookies';
import { attachDiagnosticId, createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';
import { userAgent } from './config';
import type { DiagnosticDetails, DiagnosticFlow } from '../utils/diagnostics';
import type { Cookie } from '../types';

export interface AppleRequestOptions {
  host: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Cookie[];
  /** Browser-only correlation context; never forwarded in Apple headers or bodies. */
  diagnostics?: DiagnosticFlow;
}

export interface AppleResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  body: string;
}

export async function appleRequest(opts: AppleRequestOptions): Promise<AppleResponse> {
  const flow = opts.diagnostics ?? createDiagnosticFlow('login');
  const started = Date.now();
  const endpoint = diagnosticEndpoint(opts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  flow.log('apple_request', 'start', { endpoint });
  try {
    await initLibcurl(flow);

    const url = `https://${opts.host}${opts.path}`;
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      ...opts.headers,
    };

    if (opts.cookies?.length) {
      const cookieHeader = buildCookieHeader(opts.cookies, url);
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }
    }

    const resp = await libcurl.fetch(url, {
      method: opts.method,
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: controller.signal,
      _libcurl_http_version: 1.1,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of resp.raw_headers) {
      responseHeaders[key.toLowerCase()] = value;
    }

    const body = await resp.text();

    flow.log('apple_request', resp.status >= 400 ? 'failure' : 'transition', {
      endpoint,
      httpStatus: resp.status,
      durationMs: Date.now() - started,
      ...(resp.status >= 400 ? { reason: 'http_error' as const } : {}),
    });
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      rawHeaders: resp.raw_headers,
      body,
    };
  } catch (error) {
    const failure = controller.signal.aborted ? new DOMException('Apple request timed out', 'TimeoutError') : error;
    flow.log('apple_request', 'failure', {
      ...errorDiagnosticDetails(failure),
      endpoint,
      durationMs: Date.now() - started,
    });
    throw attachDiagnosticId(failure, flow.id);
  } finally {
    clearTimeout(timeout);
  }
}

function diagnosticEndpoint(opts: AppleRequestOptions): DiagnosticDetails['endpoint'] {
  const path = opts.path.split('?')[0];
  if (opts.host === 'auth.itunes.apple.com') return 'native_auth';
  if (opts.host === 's.mzstatic.com' || opts.host === 'fpinit.itunes.apple.com') return 'sap';
  if (opts.host === 'uclient-api.itunes.apple.com') return 'public_version';
  if (opts.host === 'init.itunes.apple.com') return 'bag';
  if (/\/authenticate\/?$/.test(path)) return 'legacy_auth';
  if (path.endsWith('/buyProduct')) return 'purchase';
  if (path.endsWith('/volumeStoreDownloadProduct')) return 'volume_download';
  if (path.endsWith('/ent/download')) return 'ent_download';
  if (path.endsWith('/redownload')) return 'redownload';
  if (path.endsWith('/updateProduct')) return 'update';
  return undefined;
}
