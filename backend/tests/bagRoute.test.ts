import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import https from 'https';
import { EventEmitter } from 'events';
import bagRoutes from '../src/routes/bag.js';
import { BAG_TIMEOUT_MS } from '../src/config.js';

function createApp() {
  const app = express();
  app.use('/api', bagRoutes);
  return app;
}

describe('Bag Route', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends Configurator headers when fetching bag', async () => {
    const getSpy = vi.spyOn(https, 'get').mockImplementation((url: any, options: any, cb: any) => {
      const response = new EventEmitter() as any;
      response.statusCode = 200;
      setTimeout(() => {
        response.emit(
          'data',
          '<Document><Protocol><plist version="1.0"><dict><key>urlBag</key><dict><key>authenticateAccount</key><string>https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate</string></dict></dict></plist></Protocol></Document>',
        );
        response.emit('end');
      }, 0);
      cb(response);
      return new EventEmitter() as any;
    });

    const app = createApp();
    const res = await request(app).get('/api/bag?guid=aabbccddeeff');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<plist');
    expect(getSpy).toHaveBeenCalledTimes(1);

    const [url, options] = getSpy.mock.calls[0];
    expect(String(url)).toBe('https://init.itunes.apple.com/bag.xml?ix=6&guid=aabbccddeeff');
    expect(options.headers['User-Agent']).toContain('Configurator/2.21');
    expect(options.headers.Accept).toBe('application/xml');
  });

  it('returns 502 when bag upstream is HTTP error', async () => {
    vi.spyOn(https, 'get').mockImplementation((url: any, options: any, cb: any) => {
      const response = new EventEmitter() as any;
      response.statusCode = 403;
      setTimeout(() => {
        response.emit('data', 'forbidden');
        response.emit('end');
      }, 0);
      cb(response);
      return new EventEmitter() as any;
    });

    const app = createApp();
    const res = await request(app).get('/api/bag?guid=aabbccddeeff');

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Bag request failed');
  });

  function controlledRequest() {
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const upstream = Object.assign(new EventEmitter(), {
      destroy: vi.fn(function (this: EventEmitter) {
        queueMicrotask(() => this.emit('error', new Error('fixture cancellation')));
      }),
    });
    vi.spyOn(https, 'get').mockImplementation((_url: any, options: any, cb: any) => {
      options.signal?.addEventListener('abort', () => upstream.destroy(), { once: true });
      cb(response);
      return upstream as any;
    });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      destroyed: false,
      set: vi.fn().mockReturnThis(),
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json: vi.fn(function (this: any) {
        this.writableEnded = true;
        this.emit('finish');
        return this;
      }),
    });
    const req = { query: { guid: 'aabbccddeeff' }, get: () => undefined };
    const route = (bagRoutes as any).stack.find((layer: any) => layer.route?.path === '/bag').route;
    return { response, upstream, res, run: () => route.stack[0].handle(req, res) as Promise<void> };
  }

  it('enforces a total deadline even while the upstream keeps sending small chunks', async () => {
    vi.useFakeTimers();
    const { response, upstream, res, run } = controlledRequest();
    const running = run();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(BAG_TIMEOUT_MS / 4);
      response.emit('data', Buffer.from(' '));
    }
    await vi.advanceTimersByTimeAsync(BAG_TIMEOUT_MS / 4);
    const cancelled = upstream.destroy.mock.calls.length > 0;
    // Complete the pre-fix handler so a missing timer cannot hang this test.
    response.emit('end');
    await running;
    expect(cancelled).toBe(true);
    expect(res.statusCode).toBe(504);
  });

  it('cancels the upstream request when the caller disconnects', async () => {
    const { response, upstream, res, run } = controlledRequest();
    const running = run();
    res.destroyed = true;
    res.emit('close');
    const cancelled = upstream.destroy.mock.calls.length > 0;
    response.emit('end');
    await running;
    expect(cancelled).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
  });
});
