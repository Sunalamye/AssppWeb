import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import * as plist from '../../src/apple/plist';
import { purchaseApp, PurchaseError } from '../../src/apple/purchase';
import { appleRequest } from '../../src/apple/request';
import { clearDiagnosticEvents, getDiagnosticEvents } from '../../src/utils/diagnostics';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));

const account: Account = {
  email: 'test@example.com',
  password: 'password',
  appleId: 'test@example.com',
  store: '143441',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token',
  directoryServicesIdentifier: '123',
  cookies: [],
  deviceIdentifier: 'aabbccddeeff',
  pod: '26',
};

const app = { id: 1413936031, price: 0 } as Software;

function respondWith(dict: Record<string, unknown>) {
  vi.mocked(appleRequest).mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    rawHeaders: [],
    body: buildPlist(dict),
  });
}

describe('apple/purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDiagnosticEvents();
  });

  it('treats failureType 5002 as an already-owned license', async () => {
    respondWith({
      failureType: '5002',
      customerMessage: 'An unknown error has occurred',
    });

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      alreadyOwned: true,
    });
    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(getDiagnosticEvents().at(-1)).toMatchObject({ outcome: 'success', purchaseBranch: 'already_owned' });
  });

  it('reports a fresh purchase as not previously owned', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0 });

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      alreadyOwned: false,
    });
    expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front']).toBe('143441-1');
    expect(getDiagnosticEvents().at(-1)).toMatchObject({
      outcome: 'success',
      purchaseBranch: 'success',
      failureTypeKind: 'missing',
      statusKind: 'zero',
      dialogPresent: false,
      actionPresent: false,
      messagePresent: false,
      dialogKind: 'missing',
      actionKind: 'missing',
    });
  });

  it('preserves the complete storefront returned by native authentication', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0 });
    await purchaseApp({ ...account, storeFront: '143441-1,29' }, app);
    expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front']).toBe('143441-1,29');
  });

  it.each(['', '2059', '5002'])(
    'classifies ContentBanned as a terminal regional denial despite failureType %j',
    async (failureType) => {
      const chinaApp = { ...app, id: 1142110895 };
      respondWith({
        failureType,
        metrics: { dialogId: 'MZCommerce.ContentBanned' },
        dialog: { explanation: 'This app is unavailable in the country or region you’re in.' },
      });
      // Deliberately stale account.store must not override the actual wire header.
      const error = await purchaseApp({ ...account, storeFront: '143465-19,32' }, chinaApp).catch((error) => error);
      expect(error).toBeInstanceOf(PurchaseError);
      expect(error.diagnostics).toMatchObject({
        reason: 'region_unavailable',
        purchaseBranch: 'region_unavailable',
        dialogCode: 'MZCommerce.ContentBanned',
        storefrontId: '143465',
        catalogAppId: 1142110895,
        httpStatus: 200,
      });
      expect(error.message).toContain('storefront=143465');
      expect(appleRequest).toHaveBeenCalledTimes(1);
      const events = getDiagnosticEvents().filter((event) => event.stage === 'purchase');
      expect(events.map((event) => event.outcome)).toEqual(['start', 'transition', 'failure']);
      expect(events.every((event) => event.storefrontId === '143465' && event.catalogAppId === 1142110895)).toBe(true);
      expect(JSON.stringify(events)).not.toContain('143465-19,32');
    },
  );

  it('does not log unknown storefront values or non-catalog identifiers', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0 });
    await purchaseApp({ ...account, storeFront: 'PRIVATE_STOREFRONT' }, { ...app, id: 'PRIVATE_APP_ID' } as never);
    const events = getDiagnosticEvents();
    expect(events.every((event) => event.storefrontId === undefined && event.catalogAppId === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });

  it('does not accept a success-shaped response that carries a ContentBanned marker without a dialog', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0, metrics: { dialogId: 'MZCommerce.ContentBanned' } });
    await expect(purchaseApp(account, app)).rejects.toMatchObject({
      diagnostics: { reason: 'region_unavailable', purchaseBranch: 'region_unavailable', dialogPresent: false },
    });
    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(getDiagnosticEvents().some((event) => event.outcome === 'success' || event.outcome === 'retry')).toBe(false);
  });

  it('still rejects other failure types carrying the generic message', async () => {
    respondWith({
      failureType: '1008',
      customerMessage: 'An unknown error has occurred',
    });

    await expect(purchaseApp(account, app)).rejects.toBeInstanceOf(PurchaseError);
  });

  it('recognizes the upstream terms fixture without failureType and never logs the action URL', async () => {
    respondWith({
      jingleDocType: 'buyProductFailure',
      jingleAction: 'buyProduct',
      action: {
        kind: 'Goto',
        url: 'https://p45-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/com.apple.jingle.app.finance.DirectAction/termsPage?token=PRIVATE_QUERY',
      },
    });
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.diagnostics.reason).toBe('terms_required');
    expect(error.diagnostics.purchaseBranch).toBe('terms_required');
    expect(error.message).toContain('HTTP 200');
    expect(error.message).not.toContain('PRIVATE_QUERY');
    expect(JSON.stringify(getDiagnosticEvents())).not.toContain('PRIVATE_QUERY');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://example.com/WebObjects/MZFinance.woa/wa/com.apple.jingle.app.finance.DirectAction/termsPage',
    'https://p45-buy.itunes.apple.com/other/termsPage',
    'http://p45-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/com.apple.jingle.app.finance.DirectAction/termsPage',
  ])('does not follow or approve an unrelated terms-looking action %s', async (url) => {
    respondWith({ jingleDocType: 'buyProductFailure', action: { kind: 'Goto', url } });
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error.diagnostics.reason).toBe('unexpected_response');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ customerMessage: 'Please review your account.' }, 'Please review your account.'],
    [
      { dialog: { message: 'Account action required', explanation: 'Open the App Store to continue.' } },
      'Open the App Store to continue.',
    ],
  ])('preserves Apple messages without a failureType', async (dict, message) => {
    respondWith(dict as Record<string, unknown>);
    await expect(purchaseApp(account, app)).rejects.toThrow(message as string);
  });

  it.each([
    [{ customerMessage: 'Your password has changed.' }, 'token_expired'],
    [{ customerMessage: 'Subscription Required' }, 'subscription_required'],
    [{ failureType: '1008' }, 'device_verification'],
    [{ failureType: '2042' }, 'token_expired'],
    [{ metrics: { dialogId: 'MZCommerce.ExpiredPasswordToken' } }, 'token_expired'],
  ])('classifies account transitions independently from a generic failure', async (dict, reason) => {
    respondWith(dict as Record<string, unknown>);
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.diagnostics.reason).toBe(reason);
    expect(error.diagnostics.purchaseBranch).toBe(reason);
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('identifies an unknown public Apple dialog without a purchase document or failure code', async () => {
    // Synthetic identifier: the previous log retained only "other", so the real
    // identifier from that response cannot be reconstructed from those events.
    const dialogCode = 'MZCommerce.FixtureAuthorizationRequired';
    respondWith({
      metrics: { dialogId: dialogCode, privateAccount: account.email },
      dialog: {
        kind: 'authorization',
        explanation: 'PRIVATE_ACCOUNT_MESSAGE',
        okButtonAction: { kind: 'SignIn', url: 'https://example.invalid/?token=PRIVATE_ACTION_TOKEN' },
      },
      passwordToken: 'PRIVATE_RESPONSE_TOKEN',
    });

    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.diagnostics).toMatchObject({
      httpStatus: 200,
      responseType: 'missing',
      dialog: 'other',
      dialogCode,
      reason: 'unexpected_response',
      purchaseBranch: 'dialog_present',
      failureTypeKind: 'missing',
      statusKind: 'missing',
      dialogPresent: true,
      actionPresent: false,
      messagePresent: true,
      dialogKind: 'authorization',
      actionKind: 'missing',
    });
    expect(error.message).toContain(`dialog=${dialogCode}`);
    expect(error.message).toContain('branch=dialog_present');
    expect(error.message).toContain('status=missing');
    expect(appleRequest).toHaveBeenCalledTimes(1);
    const events = getDiagnosticEvents();
    expect(events.at(-1)).toMatchObject({ outcome: 'failure', purchaseBranch: 'dialog_present', dialogCode });
    expect(events.some((event) => event.outcome === 'retry' || event.outcome === 'success')).toBe(false);
    const serialized = JSON.stringify(events);
    for (const secret of [
      account.email,
      account.passwordToken,
      'PRIVATE_ACCOUNT_MESSAGE',
      'PRIVATE_ACTION_TOKEN',
      'PRIVATE_RESPONSE_TOKEN',
    ])
      expect(serialized).not.toContain(secret);
  });

  it.each([
    [{ failureType: {} }, 'invalid_failure_type'],
    [{ customerMessage: [] }, 'invalid_customer_message'],
    [{ dialog: {} }, 'dialog_present'],
    [{ action: { kind: 'Goto' } }, 'action_present'],
    [{ jingleDocType: 'purchaseSuccess', status: '0' }, 'invalid_status'],
    [{ failureType: '5002', customerMessage: 'Account action required' }, 'conflicting_message'],
    [{ failureType: '9610', customerMessage: 'Account action required' }, 'failure_code'],
    [{ customerMessage: 'Account action required' }, 'customer_message'],
    [{ status: 0 }, 'missing_success_document'],
    [{ jingleDocType: 'purchaseSuccess' }, 'missing_success_status'],
  ])('records the exact rejection branch for response %#', async (dict, purchaseBranch) => {
    respondWith(dict as Record<string, unknown>);
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.diagnostics.purchaseBranch).toBe(purchaseBranch);
    expect(getDiagnosticEvents().at(-1)).toMatchObject({ outcome: 'failure', purchaseBranch });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('retains only recognized action kinds and drops private dialog identifiers', async () => {
    respondWith({
      metrics: { dialogId: 'MZCommerce.PRIVATE_TOKEN_123456789' },
      dialog: { kind: 'PRIVATE_DIALOG_KIND', message: 'PRIVATE_DIALOG_MESSAGE' },
      action: { kind: 'SignIn', url: 'https://example.invalid/?token=PRIVATE_ACTION_URL' },
    });
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error.diagnostics).toMatchObject({
      dialog: 'other',
      dialogPresent: true,
      actionPresent: true,
      dialogKind: 'other',
      actionKind: 'SignIn',
      messagePresent: true,
      purchaseBranch: 'dialog_present',
    });
    expect(error.diagnostics).not.toHaveProperty('dialogCode');
    expect(error.message).toContain('dialog=other');
    expect(error.message).not.toContain('PRIVATE_TOKEN_123456789');
    expect(JSON.stringify(getDiagnosticEvents())).not.toContain('PRIVATE_');
  });

  it.each(['MZCommerce.FixtureDialog\n', ' MZCommerce.FixtureDialog', 'MZCommerce.FixtureDialog%0A'])(
    'does not normalize an invalid raw dialog identifier into a permitted code %#',
    async (dialogId) => {
      respondWith({ metrics: { dialogId } });
      const error = await purchaseApp(account, app).catch((error) => error);
      expect(error.diagnostics).toMatchObject({ dialog: 'other', purchaseBranch: 'missing_success_document' });
      expect(error.diagnostics).not.toHaveProperty('dialogCode');
      expect(error.message).not.toContain('MZCommerce.FixtureDialog');
      expect(JSON.stringify(getDiagnosticEvents())).not.toContain('MZCommerce.FixtureDialog');
    },
  );

  it.each([null, false, {}])('distinguishes present dialog/action values from absent fields %#', async (value) => {
    respondWith({});
    // Exercise field presence independently of XML's supported value types.
    const parser = vi.spyOn(plist, 'parsePlist').mockReturnValueOnce({ dialog: value, action: value });
    try {
      const error = await purchaseApp(account, app).catch((error) => error);
      expect(error.diagnostics).toMatchObject({
        dialogPresent: true,
        actionPresent: true,
        messagePresent: false,
        dialogKind: 'missing',
        actionKind: 'missing',
        purchaseBranch: 'dialog_present',
      });
      expect(appleRequest).toHaveBeenCalledTimes(1);
    } finally {
      parser.mockRestore();
    }
  });

  it.each([204, 302, 401, 500])('never accepts a success-shaped non-200 HTTP %i response', async (status) => {
    vi.mocked(appleRequest).mockResolvedValue({
      status,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: buildPlist({ jingleDocType: 'purchaseSuccess', status: 0 }),
    });
    await expect(purchaseApp(account, app)).rejects.toThrow(`HTTP ${status}`);
    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(getDiagnosticEvents().at(-1)).toMatchObject({
      outcome: 'failure',
      purchaseBranch: 'http_error',
      httpStatus: status,
      responseType: 'purchaseSuccess',
      statusKind: 'zero',
    });
  });

  it('does not call HTTP 500 an already-owned license', async () => {
    vi.mocked(appleRequest).mockResolvedValue({
      status: 500,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: buildPlist({ failureType: '5002' }),
    });
    await expect(purchaseApp(account, app)).rejects.toThrow('HTTP 500');
    expect(getDiagnosticEvents().at(-1)).toMatchObject({ purchaseBranch: 'http_error', errorCode: '5002' });
  });

  it.each([
    [{}, 'missing', 'missing'],
    [{ failureType: '  ', status: 0 }, 'empty', 'zero'],
    [{ failureType: 2059, status: 1 }, 'numeric', 'nonzero'],
    [{ failureType: 'PRIVATE_FAILURE_TYPE', status: 'PRIVATE_STATUS' }, 'text', 'text'],
    [{ failureType: false, status: [] }, 'invalid', 'invalid'],
  ])(
    'classifies non-200 response shapes without interpreting them as success or retry %#',
    async (shape, failureTypeKind, statusKind) => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 503,
        statusText: '',
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          ...(shape as Record<string, unknown>),
          jingleDocType: 'buyProductFailure',
          metrics: { dialogId: 'MZFinance.FixtureServiceUnavailable' },
          customerMessage: 'PRIVATE_RESPONSE_MESSAGE',
          action: { kind: 'PRIVATE_ACTION_KIND', url: 'https://example.invalid/?token=PRIVATE_URL' },
        }),
      });
      const error = await purchaseApp(account, app).catch((error) => error);
      expect(error).toBeInstanceOf(PurchaseError);
      expect(error.diagnostics).toMatchObject({
        httpStatus: 503,
        purchaseBranch: 'http_error',
        reason: 'http_error',
        responseType: 'buyProductFailure',
        dialogCode: 'MZFinance.FixtureServiceUnavailable',
        failureTypeKind,
        statusKind,
        actionKind: 'other',
        messagePresent: true,
      });
      expect(appleRequest).toHaveBeenCalledTimes(1);
      const events = getDiagnosticEvents();
      expect(events.some((event) => event.outcome === 'success' || event.outcome === 'retry')).toBe(false);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    },
  );

  it.each([
    { jingleDocType: 'purchaseSuccess' },
    { jingleDocType: 'purchaseSuccess', status: '0' },
    { jingleDocType: 'purchaseSuccess', status: 1 },
    { jingleDocType: 'purchaseSuccess', status: 0, dialog: { message: 'Not authorized' } },
    { jingleDocType: 'purchaseSuccess', status: 0, action: { kind: 'Goto', url: 'https://example.com' } },
    { jingleDocType: 'purchaseSuccess', status: 0, failureType: {} },
    { jingleDocType: 'purchaseSuccess', status: 0, failureType: [] },
    { jingleDocType: 'purchaseSuccess', status: 0, failureType: false },
    { jingleDocType: 'purchaseSuccess', status: 0, customerMessage: {} },
    { jingleDocType: 'purchaseSuccess', status: 0, customerMessage: [] },
    { jingleDocType: 'purchaseSuccess', status: 0, customerMessage: false },
    { failureType: '5002', dialog: { message: 'Not authorized' } },
  ])('rejects missing or contradictory purchase success evidence %#', async (dict) => {
    respondWith(dict);
    await expect(purchaseApp(account, app)).rejects.toBeInstanceOf(PurchaseError);
  });

  it.each([
    '',
    '<html>PRIVATE_RESPONSE</html>',
    '<plist><array/></plist>',
    '<plist><dict><key>status</key><integer>0junk</integer></dict></plist>',
  ])('reports malformed responses without serializing their body', async (body) => {
    vi.mocked(appleRequest).mockResolvedValue({ status: 200, statusText: '', headers: {}, rawHeaders: [], body });
    const error = await purchaseApp(account, app).catch((error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.message).toContain('HTTP 200');
    expect(error.diagnostics.purchaseBranch).toBe('invalid_plist');
    expect(error.message).not.toContain('PRIVATE_RESPONSE');
    expect(JSON.stringify(getDiagnosticEvents())).not.toContain('PRIVATE_RESPONSE');
  });

  it('carries newly returned cookies into the single STDQ-to-GAME transition', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 200,
        statusText: '',
        headers: {},
        rawHeaders: [['set-cookie', 'session=NEW_COOKIE; Domain=itunes.apple.com; Path=/; Secure']],
        body: buildPlist({ failureType: '2059' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: '',
        headers: {},
        rawHeaders: [],
        body: buildPlist({ jingleDocType: 'purchaseSuccess', status: 0 }),
      });
    const result = await purchaseApp(account, app);
    expect(appleRequest).toHaveBeenCalledTimes(2);
    const second = vi.mocked(appleRequest).mock.calls[1][0];
    expect(parsePlist(second.body!).pricingParameters).toBe('GAME');
    expect(second.cookies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'NEW_COOKIE' })]),
    );
    expect(result.updatedCookies).toEqual(second.cookies);
    const events = getDiagnosticEvents();
    expect(events.some((event) => event.outcome === 'retry' && event.attempt === 2)).toBe(true);
    expect(new Set(events.map((event) => event.flowId)).size).toBe(1);
    const serialized = JSON.stringify(events);
    for (const secret of [account.email, account.passwordToken, account.deviceIdentifier, 'NEW_COOKIE'])
      expect(serialized).not.toContain(secret);
  });

  it('bounds pricing retries and does not mutate the caller account', async () => {
    respondWith({ failureType: '2059' });
    const original = JSON.stringify(account);
    await expect(purchaseApp(account, app)).rejects.toMatchObject({
      code: '2059',
      diagnostics: { purchaseBranch: 'unavailable' },
    });
    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(account)).toBe(original);
  });

  it('does not let code 2059 hide an explicit dialog or trigger a second purchase', async () => {
    respondWith({ failureType: '2059', dialog: { message: 'Account action required' } });
    await expect(purchaseApp(account, app)).rejects.toThrow('Account action required');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('blocks paid apps before any Apple request', async () => {
    await expect(purchaseApp(account, { ...app, price: 1 })).rejects.toBeInstanceOf(PurchaseError);
    expect(appleRequest).not.toHaveBeenCalled();
    expect(getDiagnosticEvents().at(-1)?.reason).toBe('paid_app');
  });
});
