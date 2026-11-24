import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist, parsePlist } from '../../src/apple/plist';
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
  });

  it('reports a fresh purchase as not previously owned', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0 });

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      alreadyOwned: false,
    });
    expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front']).toBe('143441-1');
  });

  it('preserves the complete storefront returned by native authentication', async () => {
    respondWith({ jingleDocType: 'purchaseSuccess', status: 0 });
    await purchaseApp({ ...account, storeFront: '143441-1,29' }, app);
    expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front']).toBe('143441-1,29');
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
    expect(appleRequest).toHaveBeenCalledTimes(1);
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
  });

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
    await expect(purchaseApp(account, app)).rejects.toMatchObject({ code: '2059' });
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
