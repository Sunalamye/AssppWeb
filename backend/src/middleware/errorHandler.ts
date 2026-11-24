import { Request, Response, NextFunction } from 'express';
import { createServerDiagnostic } from '../utils/diagnostics.js';

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  // Parser and transport Error messages can embed request fragments or signed
  // URLs. Report a fixed category, never the Error or its message/stack.
  const status = 'status' in err && [400, 413, 415].includes(Number(err.status)) ? Number(err.status) : 500;
  createServerDiagnostic('settings', req.get('X-Asspp-Flow-Id')).event('action', 'failure', {
    httpStatus: status,
    reason: status < 500 ? 'invalid_request' : 'unknown',
  });
  res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
}
