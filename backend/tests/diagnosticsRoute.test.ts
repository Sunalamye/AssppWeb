import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { createDiagnosticsRouter, DiagnosticRateLimiter } from '../src/routes/diagnostics.js';
import { accessAuth } from '../src/middleware/accessAuth.js';

vi.mock('../src/config.js', () => ({
  accessPasswordHash: 'protected',
  verifyAccessToken: (value: string) => value === 'fixture-access',
}));

const event = {
  schema: 1,
  flowId: '11a83a6c-730d-4a0f-95f1-98e4a144a2ad',
  sequence: 1,
  flow: 'license',
  stage: 'purchase',
  outcome: 'failure',
  at: 1_800_000_000_000,
  httpStatus: 200,
  errorCode: '-128',
  reason: 'terms_required',
  endpoint: 'purchase',
};

function app(options: Parameters<typeof createDiagnosticsRouter>[0] = {}) {
  const application = express();
  application.use('/api/diagnostics', accessAuth, createDiagnosticsRouter(options));
  application.use(express.json({ limit: '50mb' }));
  return application;
}

afterEach(() => vi.restoreAllMocks());

describe('browser diagnostic boundary', () => {
  it('accepts a single allowlisted event and emits a fixed JSON envelope', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await request(app())
      .post('/api/diagnostics')
      .set('X-Access-Token', 'fixture-access')
      .set('Cookie', 'private-cookie')
      .set('Authorization', 'private-header')
      .send(event);
    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'asspp.diagnostic', source: 'browser', ...event });
    expect(log.mock.calls.flat().join(' ')).not.toContain('private');
  });

  it('logs all new purchase classifications without changing the schema or legacy dialog value', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const input = {
      ...event,
      dialog: 'other',
      dialogCode: 'MZCommerceInAppBuy.Authorization.Required12',
      purchaseBranch: 'dialog_present',
      failureTypeKind: 'numeric',
      statusKind: 'missing',
      dialogPresent: true,
      actionPresent: false,
      messagePresent: true,
      dialogKind: 'authorization',
      actionKind: 'missing',
    };
    const response = await request(app())
      .post('/api/diagnostics')
      .set('X-Access-Token', 'fixture-access')
      .set('Cookie', 'private-cookie')
      .send(input);
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'asspp.diagnostic', source: 'browser', ...input });
    expect(log.mock.calls.flat().join(' ')).not.toContain('private');
  });

  it.each([
    'password',
    'email',
    'cookies',
    'token',
    'state',
    'headers',
    'body',
    'message',
    'stack',
    'url',
    'customerMessage',
    'metrics',
    'dialogId',
    'event',
    'source',
  ])('rejects unlisted %s without logging any request content', async (field) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await request(app())
      .post('/api/diagnostics')
      .set('X-Access-Token', 'fixture-access')
      .send({ ...event, [field]: 'private-value' });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('private-value');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [event],
    { ...event, flowId: 'email@example.com' },
    { ...event, reason: 'private error message' },
    { ...event, endpoint: 'https://apple.com/?token=secret' },
    { ...event, errorCode: 'PRIVATE_SECRET' },
    { ...event, sequence: 0 },
    { ...event, sequence: 1.5 },
    { ...event, at: -1 },
    { ...event, httpStatus: 600 },
    { ...event, statePresent: 'true' },
    { ...event, durationMs: { state: 'secret' } },
    { ...event, responseType: 'unrecognized-private-response' },
    { ...event, dialog: 'private-dialog-message' },
    { ...event, dialogCode: 'private@example.com' },
    { ...event, dialogCode: 'MZCommerce.SystemError\n' },
    { ...event, dialogCode: 'MZCommerce.SystemError\r\n' },
    { ...event, dialogCode: 'MZCommerce.SystemError\u2028' },
    { ...event, dialogCode: 'MZCommerce.SystemError?token=private' },
    { ...event, dialogCode: 'MZCommerce.SystemError/private' },
    { ...event, dialogCode: `MZCommerce.${'A'.repeat(49)}` },
    { ...event, dialogCode: ['MZCommerce.SystemError'] },
    { ...event, dialogCode: 'PROOF_FAILED' },
    { ...event, purchaseBranch: 'private-message' },
    { ...event, failureTypeKind: 'private-token' },
    { ...event, statusKind: 0 },
    { ...event, dialogKind: { message: 'private-message' } },
    { ...event, actionKind: 'https://apple.com/?token=private' },
    { ...event, dialogPresent: 'true' },
    { ...event, actionPresent: 1 },
    { ...event, messagePresent: ['private-message'] },
  ])('rejects invalid values, nested objects, and arrays', async (input) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await request(app()).post('/api/diagnostics').set('X-Access-Token', 'fixture-access').send(input);
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('private');
    expect(log).not.toHaveBeenCalled();
  });

  it('authenticates before parsing and enforces its own small body limit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const application = app();
    expect(
      (
        await request(application)
          .post('/api/diagnostics')
          .set('Content-Type', 'application/json')
          .send('{private malformed')
      ).status,
    ).toBe(401);
    const malformed = await request(application)
      .post('/api/diagnostics')
      .set('X-Access-Token', 'fixture-access')
      .set('Content-Type', 'application/json')
      .send('{"password":"private",');
    expect(malformed.status).toBe(400);
    const oversized = await request(application)
      .post('/api/diagnostics')
      .set('X-Access-Token', 'fixture-access')
      .send({ ...event, message: 'secret'.repeat(1000) });
    expect(oversized.status).toBe(413);
    expect(malformed.text + oversized.text).not.toContain('private');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('bounds per-client bursts without trusting forwarded client identities', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 1000;
    const application = app({ capacity: 2, refillPerSecond: 1, now: () => now });
    const send = (ip: string) =>
      request(application)
        .post('/api/diagnostics')
        .set('X-Access-Token', 'fixture-access')
        .set('X-Forwarded-For', ip)
        .send(event);
    expect((await send('192.0.2.1')).status).toBe(204);
    expect((await send('192.0.2.2')).status).toBe(204);
    const blocked = await send('192.0.2.3');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    now += 1000;
    expect((await send('192.0.2.4')).status).toBe(204);
  });

  it('bounds tracked clients and expires idle rate buckets', () => {
    let now = 1000;
    const limiter = new DiagnosticRateLimiter({ maxClients: 2, ttlMs: 1000, now: () => now });
    expect(limiter.allow('one')).toBe(true);
    expect(limiter.allow('two')).toBe(true);
    expect(limiter.allow('three')).toBe(false);
    now += 1000;
    expect(limiter.allow('three')).toBe(true);
  });

  it('keeps the independent browser and backend allowlists aligned', () => {
    const frontend = fs.readFileSync(new URL('../../frontend/src/utils/diagnostics.ts', import.meta.url), 'utf8');
    const backend = fs.readFileSync(new URL('../src/utils/diagnostics.ts', import.meta.url), 'utf8');
    for (const name of [
      'diagnosticFlows',
      'diagnosticStages',
      'diagnosticOutcomes',
      'diagnosticReasons',
      'diagnosticEndpoints',
      'diagnosticErrorCodes',
      'diagnosticPurchaseBranches',
      'diagnosticFailureTypeKinds',
      'diagnosticStatusKinds',
      'diagnosticDialogKinds',
      'diagnosticActionKinds',
    ]) {
      const values = (source: string) => {
        const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
        return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
      };
      expect(values(backend), name).toEqual(values(frontend));
      expect(values(backend).length).toBeGreaterThan(0);
    }
  });
});
