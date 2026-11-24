import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('@mercuryworkshop/wisp-js/server', () => ({ server: { options: {}, routeRequest: mocks.route } }));
vi.mock('../src/config.js', () => ({
  accessPasswordHash: 'protected',
  verifyAccessToken: (value: string) => value === 'fixture-access',
}));
import { setupWsProxy } from '../src/services/wsProxy.js';

beforeEach(() => mocks.route.mockReset());

function upgrade(url: string) {
  const server = new EventEmitter();
  setupWsProxy(server as any);
  const req = { url };
  const socket = { write: vi.fn(), destroy: vi.fn() };
  server.emit('upgrade', req, socket, Buffer.alloc(0));
  return { req, socket };
}

describe('Wisp credential-safe upgrade routing', () => {
  it('verifies the access token but strips all query data before calling wisp-js', () => {
    const { req } = upgrade('/wisp/?token=fixture-access&private=do-not-log');
    expect(mocks.route).toHaveBeenCalledTimes(1);
    expect(req.url).toBe('/wisp/');
    expect(mocks.route.mock.calls[0][0].url).not.toContain('fixture-access');
  });
  it.each([
    '/wisp/?token=private-invalid',
    '/wisp/?token=fixture-access&token=another',
    '/wispevil?token=fixture-access',
    '/other?token=private-invalid',
  ])('redacts rejected upgrade URLs too', (url) => {
    const { req, socket } = upgrade(url);
    expect(mocks.route).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();
    expect(req.url).not.toContain('token');
    expect(req.url).not.toContain('private');
  });
});
