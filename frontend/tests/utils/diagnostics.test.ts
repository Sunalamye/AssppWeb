import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDiagnosticEvent } from '../../src/utils/diagnosticTransport';
import {
  validAppleDialogCode as validBackendAppleDialogCode,
  validateDiagnosticEvent,
} from '../../../backend/src/utils/diagnostics';
import { validStorefrontId as validBackendStorefrontId } from '../../../backend/src/utils/storefront';
import { countryCodeMap } from '../../src/apple/config';
import { publicStorefrontId, validStorefrontId } from '../../src/utils/storefront';
import {
  attachDiagnosticId,
  clearDiagnosticEvents,
  createDiagnosticFlow,
  diagnosticActionKinds,
  diagnosticDialogKinds,
  diagnosticFailureTypeKinds,
  diagnosticPurchaseBranches,
  diagnosticStatusKinds,
  diagnosticStorefrontFields,
  diagnosticStorefrontSources,
  errorDiagnosticDetails,
  getDiagnosticEvents,
  getDiagnosticId,
  safeDiagnosticDetails,
  validAppleDialogCode,
} from '../../src/utils/diagnostics';

const baseEvent = {
  schema: 1,
  flowId: '11a83a6c-730d-4a0f-95f1-98e4a144a2ad',
  sequence: 1,
  flow: 'license',
  stage: 'purchase',
  outcome: 'failure',
  at: 1_800_000_000_000,
};

const longestDialogCode = ['MZCommerce', 'A'.repeat(48), 'B'.repeat(48), 'C'.repeat(48), 'DD'].join('.');

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

  it('retains only the classified purchase facts in memory, local storage, and transport', () => {
    const flow = createDiagnosticFlow('license');
    const details = {
      dialog: 'other',
      dialogCode: 'MZCommerceInAppBuy.Authorization.Required12',
      purchaseBranch: 'dialog_present',
      failureTypeKind: 'empty',
      statusKind: 'missing',
      dialogPresent: true,
      actionPresent: false,
      messagePresent: true,
      dialogKind: 'authorization',
      actionKind: 'missing',
    } as const;
    flow.log('purchase', 'failure', {
      ...details,
      customerMessage: 'PRIVATE_CUSTOMER_MESSAGE',
      metrics: { dialogId: 'PRIVATE_RAW_METRICS' },
      url: 'https://example.com/?password=PRIVATE_PASSWORD',
    } as never);
    const [event] = getDiagnosticEvents();
    expect(event).toMatchObject(details);
    expect(validateDiagnosticEvent(event)).toEqual(event);
    expect(enqueueDiagnosticEvent).toHaveBeenCalledWith(event);
    expect(JSON.parse(localStorage.getItem('asspp-diagnostics-v1')!)).toEqual([event]);
    expect(JSON.stringify(event)).not.toContain('PRIVATE_');
    expect(Object.keys(event).sort()).toEqual([...Object.keys(baseEvent), ...Object.keys(details)].sort());

    const error = Object.assign(new Error('PRIVATE_ERROR_MESSAGE'), {
      diagnostics: {
        ...details,
        dialogCode: 'MZCommerce.PRIVATE_TOKEN',
        customerMessage: 'PRIVATE_CUSTOMER_MESSAGE',
      },
    });
    const errorDetails = errorDiagnosticDetails(error);
    expect(errorDetails.purchaseBranch).toBe('dialog_present');
    expect(errorDetails).not.toHaveProperty('dialogCode');
    expect(JSON.stringify(errorDetails)).not.toContain('PRIVATE_');
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

describe('purchase diagnostic schema agreement', () => {
  it.each([
    'MZCommerce.CountryMismatch',
    'MZCommerce.ExpiredPasswordToken',
    'MZCommerce.SystemError',
    'MZFinance.Account.NotFound2',
    'MZCommerceInAppBuy.Authorization.Required12',
    'MZCommerce.A',
    'MZCommerce.HTTPError',
    `MZCommerce.${'A'.repeat(48)}`,
    longestDialogCode,
  ])('accepts the same bounded Apple identifier on both ends: %s', (dialogCode) => {
    expect(validAppleDialogCode(dialogCode)).toBe(true);
    expect(validBackendAppleDialogCode(dialogCode)).toBe(true);
    expect(safeDiagnosticDetails({ dialogCode })).toEqual({ dialogCode });
    expect(validateDiagnosticEvent({ ...baseEvent, dialogCode })).toEqual({ ...baseEvent, dialogCode });
  });

  it.each([
    undefined,
    null,
    1,
    true,
    {},
    ['MZCommerce.SystemError'],
    new String('MZCommerce.SystemError'),
    '',
    'MZCommerce',
    'MZCommerce.',
    'MZCommerce..SystemError',
    'MZCommerce.SystemError.',
    'MZCommerceOther.SystemError',
    'mzcommerce.SystemError',
    'OtherNamespace.SystemError',
    'MZCommerce.systemError',
    'MZCommerce.2SystemError',
    'MZCommerce.System2Error',
    'MZCommerce.SystemError123',
    'MZCommerce.private@example.com',
    'https://MZCommerce.SystemError',
    'MZCommerce.SystemError/private',
    'MZCommerce.SystemError\\private',
    'MZCommerce.SystemError?token=PRIVATE_TOKEN',
    'MZCommerce.SystemError#PRIVATE_TOKEN',
    'MZCommerce.SystemError:PRIVATE_TOKEN',
    'MZCommerce.SystemError%0A',
    'MZCommerce.SystemError"',
    "MZCommerce.SystemError'",
    ' MZCommerce.SystemError',
    'MZCommerce.SystemError ',
    'MZCommerce.System Error',
    'MZCommerce.SystemError\n',
    'MZCommerce.SystemError\r\n',
    'MZCommerce.SystemError\t',
    'MZCommerce.SystemError\0',
    'MZCommerce.SystemError\u007f',
    'MZCommerce.SystemError\u2028',
    'MZCommerce.SystemError\u2029',
    'MZCommerce.SystemError\u00a0',
    'MZCommerce.錯誤',
    'MZCommerce.Érror',
    'MZCommerce.SystemError🔒',
    'MZCommerce.Abc+Def/Ghi=',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature',
    'PROOF_FAILED',
    `MZCommerce.${'A'.repeat(49)}`,
    `${longestDialogCode}D`,
  ])('rejects the same malformed or private-looking identifier on both ends: %j', (dialogCode) => {
    expect(validAppleDialogCode(dialogCode)).toBe(false);
    expect(validBackendAppleDialogCode(dialogCode)).toBe(false);
    expect(safeDiagnosticDetails({ dialogCode } as never)).toEqual({});
    expect(validateDiagnosticEvent({ ...baseEvent, dialogCode })).toBeUndefined();
  });

  it('enforces the exact inclusive identifier limits', () => {
    expect(longestDialogCode).toHaveLength(160);
    expect(validAppleDialogCode(longestDialogCode)).toBe(true);
    expect(validAppleDialogCode(`${longestDialogCode}D`)).toBe(false);
    expect(validAppleDialogCode(`MZFinance.${'A'.repeat(46)}12`)).toBe(true);
    expect(validAppleDialogCode(`MZFinance.${'A'.repeat(47)}12`)).toBe(false);
  });

  it('accepts every new enum value and strict boolean on both ends', () => {
    const fields = {
      purchaseBranch: diagnosticPurchaseBranches,
      failureTypeKind: diagnosticFailureTypeKinds,
      statusKind: diagnosticStatusKinds,
      dialogKind: diagnosticDialogKinds,
      actionKind: diagnosticActionKinds,
      storefrontSource: diagnosticStorefrontSources,
      dialogPresent: [true, false],
      actionPresent: [true, false],
      messagePresent: [true, false],
    };
    for (const [key, values] of Object.entries(fields)) {
      for (const value of values) {
        const details = { [key]: value };
        expect(safeDiagnosticDetails(details), `${key}: ${String(value)}`).toEqual(details);
        expect(validateDiagnosticEvent({ ...baseEvent, ...details })).toEqual({ ...baseEvent, ...details });
      }
    }
  });

  it('filters malformed classification values in the browser and rejects them at the server', () => {
    for (const key of [
      'purchaseBranch',
      'failureTypeKind',
      'statusKind',
      'dialogKind',
      'actionKind',
      'dialogPresent',
      'actionPresent',
      'messagePresent',
      'storefrontSource',
    ]) {
      for (const value of ['PRIVATE_TOKEN', 'true', 0, 1, null, { password: 'PRIVATE_PASSWORD' }, ['PRIVATE_TOKEN']]) {
        const details = { [key]: value };
        expect(safeDiagnosticDetails(details), `${key}: ${JSON.stringify(value)}`).toEqual({});
        expect(validateDiagnosticEvent({ ...baseEvent, ...details })).toBeUndefined();
      }
    }
  });

  it('keeps the legacy dialog enum unchanged while adding optional dialogCode', () => {
    for (const dialog of [
      'MZCommerce.CountryMismatch',
      'MZCommerce.ExpiredPasswordToken',
      'MZCommerce.SystemError',
      'other',
      'missing',
    ]) {
      expect(safeDiagnosticDetails({ dialog } as never)).toEqual({ dialog });
      expect(validateDiagnosticEvent({ ...baseEvent, dialog })).toEqual({ ...baseEvent, dialog });
    }
    expect(safeDiagnosticDetails({ dialog: 'MZFinance.Account.NotFound2' } as never)).toEqual({});
    expect(validateDiagnosticEvent({ ...baseEvent, dialog: 'MZFinance.Account.NotFound2' })).toBeUndefined();
    expect(validateDiagnosticEvent(baseEvent)).toEqual(baseEvent);
  });

  it('accepts only the known public storefront IDs on both sides of the logging boundary', () => {
    const known = new Set(Object.values(countryCodeMap));
    for (let value = 143000; value < 144000; value++) {
      const id = String(value);
      expect(validStorefrontId(id)).toBe(known.has(id));
      expect(validBackendStorefrontId(id)).toBe(known.has(id));
    }
    for (const id of known) {
      for (const key of diagnosticStorefrontFields) {
        const details = { [key]: id };
        expect(safeDiagnosticDetails(details)).toEqual(details);
        expect(validateDiagnosticEvent({ ...baseEvent, ...details })).toEqual({ ...baseEvent, ...details });
      }
    }
    expect(publicStorefrontId('143465-19,32')).toBe('143465');
    expect(publicStorefrontId('143470')).toBe('143470');
    expect(publicStorefrontId('PRIVATE_HEADER')).toBeUndefined();
    for (const value of ['143465-19,32', '143465\n', '000000', 143465, 'PRIVATE_TOKEN', null]) {
      for (const key of diagnosticStorefrontFields) {
        const details = { [key]: value };
        expect(safeDiagnosticDetails(details as never)).toEqual({});
        expect(validateDiagnosticEvent({ ...baseEvent, ...details })).toBeUndefined();
      }
    }
  });

  it('retains a public numeric catalog ID but rejects strings and unbounded identifiers', () => {
    for (const catalogAppId of [1, 1142110895, 9_999_999_999]) {
      const details = { catalogAppId };
      expect(safeDiagnosticDetails(details)).toEqual(details);
      expect(validateDiagnosticEvent({ ...baseEvent, ...details })).toEqual({ ...baseEvent, ...details });
    }
    for (const catalogAppId of [0, -1, 1.5, 10_000_000_000, NaN, Infinity, '1142110895', 'PRIVATE_TOKEN', null]) {
      expect(safeDiagnosticDetails({ catalogAppId } as never)).toEqual({});
      expect(validateDiagnosticEvent({ ...baseEvent, catalogAppId })).toBeUndefined();
    }
  });
});
