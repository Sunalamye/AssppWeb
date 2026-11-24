import { Server as HttpServer } from 'http';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { accessPasswordHash, verifyAccessToken } from '../config.js';

// Allow only Apple hosts required by bag/auth/purchase/version/download flows.
wisp.options.hostname_whitelist = [
  /^s\.mzstatic\.com$/,
  /^fpinit\.itunes\.apple\.com$/,
  /^auth\.itunes\.apple\.com$/,
  /^buy\.itunes\.apple\.com$/,
  /^init\.itunes\.apple\.com$/,
  /^p\d+-buy\.itunes\.apple\.com$/,
  /^downloaddispatch\.itunes\.apple\.com$/,
  /^uclient-api\.itunes\.apple\.com$/,
];
wisp.options.port_whitelist = [443];
wisp.options.allow_direct_ip = false;
// allow_private_ips must be true: Docker/container DNS may resolve whitelisted
// hostnames to reserved-range IPs (e.g. 198.18.x.x in OrbStack). The hostname
// whitelist above is the primary security control.
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = false;

export function setupWsProxy(server: HttpServer) {
  server.on('upgrade', (req, socket, head) => {
    const originalURL = req.url || '';
    // The upgrade URL can contain the site access token. Clear it before any
    // library, rejected upgrade, or later error handler can log the request.
    req.url = '/';
    let url: URL;
    try {
      url = new URL(originalURL, 'http://localhost');
    } catch {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (
      originalURL.startsWith('/') &&
      url.origin === 'http://localhost' &&
      ['/wisp', '/wisp/'].includes(url.pathname)
    ) {
      req.url = '/wisp/';
      if (accessPasswordHash) {
        // Cloudflare URL normalization may append a trailing slash to the query
        // string (e.g. ?token=abc/ instead of ?token=abc), so strip it.
        const token = (url.searchParams.get('token') || '').replace(/\/+$/, '');
        if (url.searchParams.getAll('token').length !== 1 || !verifyAccessToken(token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wisp.routeRequest(req, socket, head);
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });
}
