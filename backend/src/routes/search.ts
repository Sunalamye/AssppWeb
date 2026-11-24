import { Router } from 'express';
import { observeRequest } from '../utils/diagnostics.js';
import type { Request, Response } from 'express';
import type { DiagnosticDetails } from '../utils/diagnostics.js';

const router = Router();
const catalogTimeoutMs = 15_000;

// Map iTunes API fields to our Software type, matching Swift CodingKeys
function mapSoftware(item: Record<string, any>) {
  return {
    id: item.trackId,
    bundleID: item.bundleId,
    name: item.trackName,
    version: item.version,
    price: item.price,
    artistName: item.artistName,
    sellerName: item.sellerName,
    description: item.description,
    averageUserRating: item.averageUserRating,
    userRatingCount: item.userRatingCount,
    artworkUrl: item.artworkUrl512,
    screenshotUrls: item.screenshotUrls ?? [],
    minimumOsVersion: item.minimumOsVersion,
    fileSizeBytes: item.fileSizeBytes,
    releaseDate: item.currentVersionReleaseDate ?? item.releaseDate,
    releaseNotes: item.releaseNotes,
    formattedPrice: item.formattedPrice,
    primaryGenreName: item.primaryGenreName,
  };
}

async function catalogRequest(req: Request, res: Response, endpoint: 'search' | 'lookup') {
  const trace = observeRequest(req, res, 'download', 'action', 'public_version');
  const controller = new AbortController();
  let timedOut = false;
  let reason: DiagnosticDetails['reason'] = 'network';
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, catalogTimeoutMs);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(`https://itunes.apple.com/${endpoint}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      reason = 'http_error';
      trace.event('apple_request', 'failure', { endpoint: 'public_version', reason, httpStatus: response.status });
      throw new Error('Catalog HTTP request failed');
    }
    const data: unknown = await response.json();
    controller.signal.throwIfAborted();
    const wrapper = data as { resultCount?: unknown; results?: unknown } | null;
    if (
      !wrapper ||
      typeof wrapper !== 'object' ||
      Array.isArray(wrapper) ||
      typeof wrapper.resultCount !== 'number' ||
      !Number.isSafeInteger(wrapper.resultCount) ||
      !Array.isArray(wrapper.results) ||
      wrapper.resultCount !== wrapper.results.length ||
      wrapper.results.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
    ) {
      reason = 'invalid_response';
      throw new Error('Invalid catalog response');
    }
    const results = wrapper.results.map(mapSoftware);
    if (!res.destroyed) res.json(endpoint === 'search' ? results : (results[0] ?? null));
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    trace.result({ reason: timedOut ? 'timeout' : error instanceof SyntaxError ? 'invalid_response' : reason });
    res
      .status(timedOut ? 504 : 502)
      .json({ error: endpoint === 'search' ? 'Search request failed' : 'Lookup request failed' });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
    // Cancel unconsumed error bodies as well as an interrupted successful body.
    controller.abort();
  }
}

router.get('/search', (req: Request, res: Response) => catalogRequest(req, res, 'search'));
router.get('/lookup', (req: Request, res: Response) => catalogRequest(req, res, 'lookup'));

export default router;
