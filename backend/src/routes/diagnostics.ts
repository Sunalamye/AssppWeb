import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { validateDiagnosticEvent, writeDiagnostic } from '../utils/diagnostics.js';

export const DIAGNOSTIC_MAX_BYTES = 4 * 1024;

interface RateOptions {
  capacity?: number;
  refillPerSecond?: number;
  maxClients?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Bounded process-local token buckets. Client identifiers never enter logs. */
export class DiagnosticRateLimiter {
  private readonly clients = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refill: number;
  private readonly maximum: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(options: RateOptions = {}) {
    this.capacity = options.capacity ?? 240;
    this.refill = options.refillPerSecond ?? 4;
    this.maximum = options.maxClients ?? 1024;
    this.ttl = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  allow(client: string): boolean {
    const now = this.now();
    for (const [key, bucket] of this.clients) {
      if (now - bucket.at >= this.ttl) this.clients.delete(key);
    }
    let bucket = this.clients.get(client);
    if (!bucket) {
      if (this.clients.size >= this.maximum) return false;
      bucket = { tokens: this.capacity, at: now };
      this.clients.set(client, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (Math.max(0, now - bucket.at) * this.refill) / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export function createDiagnosticsRouter(options: RateOptions = {}): Router {
  const router = Router();
  const limiter = new DiagnosticRateLimiter(options);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed' });
      return;
    }
    if (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Same-site JSON is required' });
      return;
    }
    // Do not trust caller-supplied X-Forwarded-For or use a body field as a key.
    if (!limiter.allow(req.ip || req.socket.remoteAddress || 'local')) {
      res.set('Retry-After', '1').status(429).json({ error: 'Diagnostic rate limit exceeded' });
      return;
    }
    next();
  });
  router.use(express.json({ limit: DIAGNOSTIC_MAX_BYTES, strict: true, inflate: false }));
  router.post('/', (req, res) => {
    const event = validateDiagnosticEvent(req.body);
    if (!event) {
      res.status(400).json({ error: 'Invalid diagnostic event' });
      return;
    }
    writeDiagnostic('browser', event);
    res.status(204).end();
  });
  // JSON parser errors can contain fragments of the request. Consume them here
  // before the application's generic error handler sees the Error object.
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    res
      .status(status === 413 ? 413 : 400)
      .json({ error: status === 413 ? 'Diagnostic event is too large' : 'Invalid diagnostic JSON' });
  });
  return router;
}

export default createDiagnosticsRouter();
