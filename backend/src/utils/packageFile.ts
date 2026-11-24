import fs from 'fs';
import { createServerDiagnostic } from './diagnostics.js';
import type { Request, Response } from 'express';

/** Serve an already-authorized package path while containing deletion/open races. */
export function streamPackageFile(req: Request, res: Response, filePath: string, taskId: string): void {
  const trace = createServerDiagnostic('download', req.get('X-Asspp-Flow-Id'));
  res.set('X-Asspp-Flow-Id', trace.flowId);
  res.set('X-Asspp-Request-Id', trace.requestId);
  trace.event('action', 'start', {}, { taskId });
  let settled = false;
  let stream: fs.ReadStream | undefined;

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    trace.event('action', 'failure', { reason: 'storage', httpStatus: missing ? 404 : 500 }, { taskId });
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Disposition');
    res
      .status(missing ? 404 : 500)
      .type('json')
      .json({ error: missing ? 'Package not found' : 'Failed to read package' });
  };

  res.once('finish', () => {
    if (settled) return;
    settled = true;
    trace.event('action', 'success', { httpStatus: res.statusCode }, { taskId });
  });
  res.once('close', () => {
    stream?.destroy();
    if (settled) return;
    settled = true;
    trace.event('action', 'cancelled', { reason: 'cancelled' }, { taskId });
  });

  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      fail({ code: 'ENOENT' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stats.size);
    stream = fs.createReadStream(filePath);
    stream.once('error', fail);
    stream.pipe(res);
  } catch (error) {
    fail(error);
  }
}
