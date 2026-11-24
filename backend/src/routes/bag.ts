import { Router } from 'express';
import https from 'https';
import { BAG_TIMEOUT_MS, BAG_MAX_BYTES } from '../config.js';
import { observeRequest } from '../utils/diagnostics.js';
import type { Request, Response } from 'express';

const router = Router();
const userAgent = 'Configurator/2.21 (Macintosh; OS X 27.0.1; 26A434) AppleWebKit/0625.2.5.11.6';

// Proxy for Apple's bag endpoint.
// The bag response is public data (Apple service URLs, no credentials).
// The public service directory is fetched without Apple account credentials.
router.get('/bag', async (req: Request, res: Response) => {
  const trace = observeRequest(req, res, 'login', 'bag', 'bag');
  const guid = req.query.guid as string | undefined;
  if (!guid) {
    trace.result({ reason: 'invalid_request' });
    res.status(400).json({ error: 'Missing guid parameter' });
    return;
  }

  // Validate guid format (should be hex string)
  if (!/^[a-fA-F0-9]+$/.test(guid)) {
    trace.result({ reason: 'invalid_request' });
    res.status(400).json({ error: 'Invalid guid format' });
    return;
  }

  const url = `https://init.itunes.apple.com/bag.xml?ix=6&guid=${encodeURIComponent(guid)}`;
  const controller = new AbortController();
  let timedOut = false;
  // A socket inactivity timeout can be reset forever by a trickling response.
  // Bound the entire request, including DNS, TLS and body consumption.
  const timeout = setTimeout(() => {
    timedOut = true;
    trace.result({ reason: 'timeout' });
    controller.abort();
  }, BAG_TIMEOUT_MS);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': userAgent,
            Accept: 'application/xml',
          },
          signal: controller.signal,
        },
        (resp) => {
          let data = '';
          let totalBytes = 0;

          resp.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > BAG_MAX_BYTES) {
              trace.result({ reason: 'invalid_response' });
              request.destroy();
              reject(new Error('Bag response too large'));
              return;
            }
            data += chunk;
          });
          resp.on('end', () => {
            if (resp.statusCode && resp.statusCode >= 400) {
              trace.event('bag', 'failure', { httpStatus: resp.statusCode, reason: 'http_error' });
              trace.result({ reason: 'http_error' });
              reject(new Error(`Bag upstream returned HTTP ${resp.statusCode}`));
              return;
            }
            resolve(data);
          });
          resp.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    controller.signal.throwIfAborted();
    if (res.destroyed) return;

    // Extract plist from XML wrapper
    const plistMatch = body.match(/<plist[\s\S]*<\/plist>/);
    if (!plistMatch) {
      trace.result({ reason: 'invalid_plist' });
      res.status(502).json({ error: 'No plist found in bag response' });
      return;
    }

    // Return raw plist XML for the client to parse
    res.type('text/xml').send(plistMatch[0]);
  } catch {
    if (!res.destroyed) res.status(timedOut ? 504 : 502).json({ error: 'Bag request failed' });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
    controller.abort();
  }
});

export default router;
