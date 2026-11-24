import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadAction } from '../../src/hooks/useDownloadAction';
import { authenticate, AuthenticationError } from '../../src/apple/authenticate';
import { purchaseApp, PurchaseError } from '../../src/apple/purchase';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { apiGet, apiPost } from '../../src/api/client';
import { clearDiagnosticEvents, getDiagnosticEvents, getDiagnosticId } from '../../src/utils/diagnostics';
import type { Account, Cookie, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  readAccount: vi.fn(),
  updateAccount: vi.fn(),
  addToast: vi.fn(),
  fetchTasks: vi.fn(),
}));

vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'errors.purchase.verificationRequired')
        return 'Open Accounts and complete the verification code before trying again.';
      if (key === 'errors.purchase.paidNotSupported') return 'Purchasing paid apps is not supported';
      if (key === 'errors.download.enqueueUncertain') return 'Check the download list before retrying.';
      if (key === 'toast.msgFailed') return options?.appName + '\nError: ' + options?.error;
      return key;
    },
  }),
}));
vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({ readAccount: mocks.readAccount, updateAccount: mocks.updateAccount }),
}));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (selector: (state: { addToast: typeof mocks.addToast }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));
vi.mock('../../src/store/downloads', () => ({
  useDownloadsStore: (selector: (state: { fetchTasks: typeof mocks.fetchTasks }) => unknown) =>
    selector({ fetchTasks: mocks.fetchTasks }),
}));
vi.mock('../../src/apple/authenticate', () => ({
  authenticate: vi.fn(),
  AuthenticationError: class extends Error {
    constructor(
      message: string,
      public readonly codeRequired = false,
    ) {
      super(message);
      this.name = 'AuthenticationError';
    }
  },
}));
vi.mock('../../src/apple/purchase', () => ({
  purchaseApp: vi.fn(),
  PurchaseError: class extends Error {
    constructor(
      message: string,
      public readonly code?: string,
    ) {
      super(message);
      this.name = 'PurchaseError';
    }
  },
}));
vi.mock('../../src/apple/download', () => ({ getDownloadInfo: vi.fn() }));
vi.mock('../../src/apple/versionFinder', () => ({ listVersions: vi.fn() }));
vi.mock('../../src/apple/versionLookup', () => ({ getVersionMetadata: vi.fn() }));
vi.mock('../../src/api/client', () => ({ apiPost: vi.fn(), apiGet: vi.fn() }));
vi.mock('../../src/utils/account', () => ({ accountHash: vi.fn().mockResolvedValue('synthetic-account-hash') }));

const cookie = (value: string): Cookie => ({
  name: 'session',
  value,
  domain: '.itunes.apple.com',
  path: '/',
  httpOnly: true,
  secure: true,
});
const account: Account = {
  email: 'account@example.invalid',
  password: 'synthetic-private-password',
  appleId: 'account@example.invalid',
  store: '143441',
  storeFront: '143441-1,29',
  firstName: 'Example',
  lastName: 'Account',
  passwordToken: 'synthetic-old-token',
  directoryServicesIdentifier: '123456789',
  cookies: [cookie('synthetic-old-cookie')],
  deviceIdentifier: '001122aabbcc',
  pod: '25',
};
const renewed: Account = {
  ...account,
  passwordToken: 'synthetic-renewed-token',
  cookies: [cookie('synthetic-renewed-cookie')],
  pod: '47',
  storeFront: '143441-1,32',
};
const app = { id: 1234567890, name: 'Free App', price: 0, version: '1.0', bundleID: 'example.free' } as Software;
const output = {
  downloadURL: 'https://example.invalid/private-download',
  bundleShortVersionString: '2.0',
  sinfs: [{ id: 1, sinf: 'synthetic-sinf' }],
  iTunesMetadata: { privateMetadata: 'synthetic-metadata' },
};
const flowShape = expect.objectContaining({ id: expect.any(String), log: expect.any(Function) });

beforeEach(() => {
  vi.clearAllMocks();
  clearDiagnosticEvents();
  mocks.readAccount.mockReset().mockResolvedValue(account);
  mocks.updateAccount.mockReset().mockResolvedValue(undefined);
  mocks.fetchTasks.mockReset().mockResolvedValue(undefined);
  vi.mocked(authenticate).mockReset().mockResolvedValue(renewed);
  vi.mocked(purchaseApp)
    .mockReset()
    .mockResolvedValue({ updatedCookies: [cookie('synthetic-purchase-cookie')], alreadyOwned: false });
  vi.mocked(apiGet).mockReset().mockResolvedValue({ maxDownloadMB: 0 });
  vi.mocked(apiPost).mockReset().mockResolvedValue({ id: 'task' });
  vi.mocked(getDownloadInfo)
    .mockReset()
    .mockResolvedValue({ output, updatedCookies: renewed.cookies } as never);
  vi.mocked(listVersions)
    .mockReset()
    .mockResolvedValue({ versions: ['123'], updatedCookies: renewed.cookies } as never);
  vi.mocked(getVersionMetadata)
    .mockReset()
    .mockResolvedValue({ version: '2.0', updatedCookies: renewed.cookies } as never);
});

describe('useDownloadAction.acquireLicense', () => {
  it.each([
    new AuthenticationError('Apple authentication returned HTTP 204 after three attempts'),
    new Error('Device verification failed (PROOF_FAILED; HTTP 502). Try signing in again.'),
  ])('preserves the renewal error and never purchases with the old token: %s', async (failure) => {
    vi.mocked(authenticate).mockRejectedValue(failure);
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toBe(failure);
    expect(purchaseApp).not.toHaveBeenCalled();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    result.current.toastLicenseError(account, app, failure);
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Free App\nError: ' + failure.message + '\n[flow: ' + getDiagnosticId(failure) + ']',
      'error',
      'toast.title.licenseFailed',
    );
    const visible = JSON.stringify([mocks.addToast.mock.calls, getDiagnosticEvents()]);
    for (const secret of [account.password, account.passwordToken, account.cookies[0].value])
      expect(visible).not.toContain(secret);
  });

  it('preserves the 2FA requirement and directs the user to the account verification flow', async () => {
    vi.mocked(authenticate).mockRejectedValue(new AuthenticationError('Verification code required', true));
    const { result } = renderHook(() => useDownloadAction());
    const failure = await result.current.acquireLicense(account, app).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(failure).toMatchObject({
      codeRequired: true,
      message: 'Open Accounts and complete the verification code before trying again.',
    });
    expect(purchaseApp).not.toHaveBeenCalled();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'account_refresh', outcome: 'failure', codeRequired: true }),
      ]),
    );
  });

  it('refreshes using current cookies, preserves storefront context, and saves before purchase', async () => {
    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);
    expect(authenticate).toHaveBeenCalledWith(
      account.email,
      account.password,
      undefined,
      account.cookies,
      account.deviceIdentifier,
      undefined,
      undefined,
      flowShape,
      account,
    );
    const flow = vi.mocked(authenticate).mock.calls[0][7];
    expect(mocks.updateAccount).toHaveBeenNthCalledWith(1, renewed, flow);
    expect(mocks.updateAccount.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(purchaseApp).mock.invocationCallOrder[0],
    );
    expect(purchaseApp).toHaveBeenCalledExactlyOnceWith(renewed, app, flow);
    expect(mocks.updateAccount).toHaveBeenNthCalledWith(
      2,
      { ...renewed, cookies: [cookie('synthetic-purchase-cookie')] },
      flow,
    );
    expect(mocks.addToast).toHaveBeenCalledWith('toast.msg', 'success', 'toast.title.licenseSuccess');
    expect(new Set(getDiagnosticEvents().map((event) => event.flowId)).size).toBe(1);
  });

  it('stops before purchase if saving the renewed session fails', async () => {
    const failure = new Error('Could not save the renewed session');
    mocks.updateAccount.mockRejectedValue(failure);
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toBe(failure);
    expect(purchaseApp).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('preserves purchase errors without another refresh or automatic purchase attempt', async () => {
    const failure = new PurchaseError('Apple requires updated terms', '2042');
    vi.mocked(purchaseApp).mockRejectedValue(failure);
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toBe(failure);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(purchaseApp).toHaveBeenCalledTimes(1);
    expect(mocks.updateAccount).toHaveBeenCalledExactlyOnceWith(renewed, flowShape);
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('keeps the already-owned outcome and saves the returned cookies', async () => {
    vi.mocked(purchaseApp).mockResolvedValue({ updatedCookies: renewed.cookies, alreadyOwned: true });
    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);
    expect(mocks.updateAccount).toHaveBeenNthCalledWith(2, renewed, flowShape);
    expect(mocks.addToast).toHaveBeenCalledWith('toast.msg', 'success', 'toast.title.licenseOwned');
  });

  it('rejects paid apps before authentication or purchase', async () => {
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, { ...app, price: 0.99 })).rejects.toThrow(
      'Purchasing paid apps is not supported',
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(purchaseApp).not.toHaveBeenCalled();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
  });
});

describe('account/action state boundaries', () => {
  it('reads the latest persisted account instead of trusting an older view snapshot', async () => {
    mocks.readAccount.mockResolvedValue(renewed);
    const { result } = renderHook(() => useDownloadAction());
    await result.current.startDownload(account, app);
    expect(getDownloadInfo).toHaveBeenCalledExactlyOnceWith(renewed, app, undefined, flowShape);
  });

  it('blocks requests for an account deleted by another view', async () => {
    mocks.readAccount.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toMatchObject({
      diagnostics: { reason: 'not_found' },
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(purchaseApp).not.toHaveBeenCalled();
  });

  it('blocks concurrent actions for the same account across hook instances', async () => {
    let finish!: (value: Account) => void;
    vi.mocked(authenticate).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const first = renderHook(() => useDownloadAction());
    const second = renderHook(() => useDownloadAction());
    const pending = first.result.current.acquireLicense(account, app);
    await expect(second.result.current.startDownload(account, app)).rejects.toMatchObject({
      diagnostics: { reason: 'busy' },
    });
    expect(getDownloadInfo).not.toHaveBeenCalled();
    finish(renewed);
    await pending;
    expect(authenticate).toHaveBeenCalledOnce();
    expect(purchaseApp).toHaveBeenCalledOnce();
  });

  it('does not enqueue a download if saving returned cookies fails', async () => {
    mocks.updateAccount.mockRejectedValue(new Error('Storage failed'));
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.startDownload(account, app)).rejects.toThrow('Storage failed');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('refreshes the task list after an uncertain enqueue and never sends a second POST', async () => {
    const failure = Object.assign(new Error('Connection closed'), { diagnostics: { reason: 'network' } });
    vi.mocked(apiPost).mockRejectedValue(failure);
    const { result } = renderHook(() => useDownloadAction());
    const caught = await result.current.startDownload(account, app).catch((error) => error);
    expect(caught.message).toContain('Connection closed');
    expect(caught.message).toContain('Check the download list before retrying.');
    expect(caught.diagnostics.reason).toBe('network');
    expect(apiPost).toHaveBeenCalledOnce();
    expect(mocks.fetchTasks).toHaveBeenCalledOnce();
    const flow = vi.mocked(getDownloadInfo).mock.calls[0][3];
    expect(vi.mocked(apiPost).mock.calls[0][2]).toEqual({ 'X-Asspp-Flow-Id': flow?.id });
    expect(mocks.fetchTasks).toHaveBeenCalledWith(flow);
    expect(getDiagnosticId(caught)).toBe(flow?.id);
    expect(mocks.addToast).not.toHaveBeenCalled();
    const history = JSON.stringify(getDiagnosticEvents());
    for (const secret of [
      account.email,
      account.password,
      account.passwordToken,
      account.cookies[0].value,
      output.downloadURL,
      'synthetic-sinf',
      'synthetic-metadata',
    ]) {
      expect(history).not.toContain(secret);
    }
  });

  it('does not turn a successful enqueue into a failed download when its list refresh fails', async () => {
    mocks.fetchTasks.mockRejectedValue(new Error('List unavailable'));
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.startDownload(account, app)).resolves.toBe(true);
    expect(apiPost).toHaveBeenCalledOnce();
    expect(mocks.addToast).toHaveBeenCalledWith('toast.msg', 'info', 'toast.title.downloadStarted');
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'task_state', outcome: 'failure' }),
        expect.objectContaining({ stage: 'download_enqueue', outcome: 'success' }),
      ]),
    );
  });

  it('stops before protocol work when the configured size limit is exceeded', async () => {
    vi.mocked(apiGet).mockResolvedValue({ maxDownloadMB: 1 });
    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.startDownload(account, { ...app, fileSizeBytes: '2097152' })).resolves.toBe(false);
    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('persists version-list and metadata cookies through the same account lock', async () => {
    const { result } = renderHook(() => useDownloadAction());
    await result.current.loadVersions(account, app);
    await result.current.loadVersionMetadata(account, app, '123');
    expect(listVersions).toHaveBeenCalledWith(account, app, flowShape);
    expect(getVersionMetadata).toHaveBeenCalledWith(account, app, '123', flowShape);
    expect(mocks.updateAccount).toHaveBeenCalledTimes(2);
    expect(mocks.updateAccount).toHaveBeenLastCalledWith({ ...account, cookies: renewed.cookies }, flowShape);
  });
});
