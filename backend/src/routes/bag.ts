import { Router, Request, Response } from 'express';
import https from 'https';
import { BAG_TIMEOUT_MS, BAG_MAX_BYTES } from '../config.js';

const router = Router();
const userAgent = 'Configurator/2.21 (Macintosh; OS X 27.0.1; 26A434) AppleWebKit/0625.2.5.11.6';

// Proxy for Apple's bag endpoint.
// The bag response is public data (Apple service URLs, no credentials).
// The public service directory is fetched without Apple account credentials.
router.get('/bag', async (req: Request, res: Response) => {
  const guid = req.query.guid as string | undefined;
  if (!guid) {
    res.status(400).json({ error: 'Missing guid parameter' });
    return;
  }

  // Validate guid format (should be hex string)
  if (!/^[a-fA-F0-9]+$/.test(guid)) {
    res.status(400).json({ error: 'Invalid guid format' });
    return;
  }

  const url = `https://init.itunes.apple.com/bag.xml?ix=6&guid=${encodeURIComponent(guid)}`;

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': userAgent,
            Accept: 'application/xml',
          },
          timeout: BAG_TIMEOUT_MS,
        },
        (resp) => {
          let data = '';
          let totalBytes = 0;

          resp.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > BAG_MAX_BYTES) {
              request.destroy();
              reject(new Error('Bag response too large'));
              return;
            }
            data += chunk;
          });
          resp.on('end', () => {
            if (resp.statusCode && resp.statusCode >= 400) {
              reject(new Error(`Bag upstream returned HTTP ${resp.statusCode}`));
              return;
            }
            resolve(data);
          });
          resp.on('error', reject);
        },
      );
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Bag request timed out'));
      });
    });

    // Extract plist from XML wrapper
    const plistMatch = body.match(/<plist[\s\S]*<\/plist>/);
    if (!plistMatch) {
      res.status(502).json({ error: 'No plist found in bag response' });
      return;
    }

    // Return raw plist XML for the client to parse
    res.type('text/xml').send(plistMatch[0]);
  } catch (err) {
    console.error('Bag proxy error:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bag request failed' });
  }
});

export default router;
