import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDiagnosticEvent } from '../../src/utils/diagnosticTransport';
import {
  attachDiagnosticId,
  clearDiagnosticEvents,
  createDiagnosticFlow,
  errorDiagnosticDetails,
  getDiagnosticEvents,
  getDiagnosticId,
} from '../../src/utils/diagnostics';

describe('safe diagnostics', () => {
  beforeEach(() => {
    clearDiagnosticEvents();
    vi.clearAllMocks();
  });

  it('correlates ordered transitions without copying unknown fields or private values', () => {
    const flow = createDiagnosticFlow('license');
    flow.log('action', 'start');
    flow.log('purchase', 'failure', {
      httpStatus: 200,
      errorCode: '2034',
      reason: 'token_expired',
      password: 'PRIVATE_PASSWORD',
      body: 'PRIVATE_BODY',
      cookies: ['PRIVATE_COOKIE'],
      responseType: 'PRIVATE_TOKEN',
      dialog: 'PRIVATE_DIALOG',
      endpoint: 'https://example.com/?token=PRIVATE_URL',
    } as never);
    const events = getDiagnosticEvents();
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.every((event) => event.flowId === flow.id)).toBe(true);
    expect(events[1]).toMatchObject({ httpStatus: 200, errorCode: '2034', reason: 'token_expired' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    expect(JSON.stringify(vi.mocked(enqueueDiagnosticEvent).mock.calls)).not.toContain('PRIVATE_');
    expect(localStorage.getItem('asspp-diagnostics-v1')).not.toContain('PRIVATE_');
  });

  it('bounds history and returns defensive copies', () => {
    const flow = createDiagnosticFlow('login');
    for (let i = 0; i < 205; i++) flow.log('authentication', 'transition');
    const events = getDiagnosticEvents();
    expect(events).toHaveLength(200);
    expect(events[0].sequence).toBe(6);
    events[0].flowId = 'changed';
    expect(getDiagnosticEvents()[0].flowId).toBe(flow.id);
    clearDiagnosticEvents();
    expect(getDiagnosticEvents()).toEqual([]);
    expect(localStorage.getItem('asspp-diagnostics-v1')).toBeNull();
  });

  it('classifies errors without reading their message or stack into events', () => {
    const error = Object.assign(new Error('PRIVATE_PASSWORD PRIVATE_COOKIE'), { code: 'PROVISIONING_EXPIRED' });
    expect(errorDiagnosticDetails(error)).toEqual({ reason: 'expired', errorCode: 'PROVISIONING_EXPIRED' });
    expect(JSON.stringify(errorDiagnosticDetails(Object.assign(error, { code: 'PRIVATE_TOKEN' })))).not.toContain(
      'PRIVATE_',
    );
    expect(errorDiagnosticDetails(Object.assign(error, { codeRequired: true }))).toMatchObject({
      reason: 'verification_required',
      codeRequired: true,
    });
    expect(errorDiagnosticDetails(new DOMException('private', 'TimeoutError'))).toEqual({ reason: 'timeout' });
  });

  it('preserves the original error identity while making its flow discoverable', () => {
    const flow = createDiagnosticFlow('download');
    const error = new Error('original failure');
    expect(attachDiagnosticId(error, flow.id)).toBe(error);
    expect(getDiagnosticId(error)).toBe(flow.id);
    const frozen = Object.freeze(new Error('frozen'));
    expect(() => attachDiagnosticId(frozen, flow.id)).not.toThrow();
  });

  it('keeps account operations observable when localStorage is unavailable', () => {
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      expect(() => createDiagnosticFlow('login').log('action', 'start')).not.toThrow();
      expect(getDiagnosticEvents()).toHaveLength(1);
      expect(enqueueDiagnosticEvent).toHaveBeenCalledTimes(1);
    } finally {
      localStorage.setItem = original;
    }
  });
});
