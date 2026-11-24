import { Router, Request, Response } from 'express';
import { observeRequest } from '../utils/diagnostics.js';

const router = Router();

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

router.get('/search', async (req: Request, res: Response) => {
  const trace = observeRequest(req, res, 'download', 'action', 'public_version');
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(`https://itunes.apple.com/search?${params.toString()}`);
    const data = await response.json();
    const results = (data.results ?? []).map(mapSoftware);
    res.json(results);
  } catch {
    trace.result({ reason: 'network' });
    res.status(500).json({ error: 'Search request failed' });
  }
});

router.get('/lookup', async (req: Request, res: Response) => {
  const trace = observeRequest(req, res, 'download', 'action', 'public_version');
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(`https://itunes.apple.com/lookup?${params.toString()}`);
    const data = await response.json();
    if (!data.resultCount || !data.results?.length) {
      res.json(null);
      return;
    }
    res.json(mapSoftware(data.results[0]));
  } catch {
    trace.result({ reason: 'network' });
    res.status(500).json({ error: 'Lookup request failed' });
  }
});

export default router;
