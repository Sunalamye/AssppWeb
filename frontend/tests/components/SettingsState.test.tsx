import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '../../src/components/Settings/SettingsPage';
import { clearDiagnosticEvents, createDiagnosticFlow, getDiagnosticEvents } from '../../src/utils/diagnostics';
import { withAccountAction } from '../../src/utils/accountActions';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  clearProof: vi.fn(),
  clearAccounts: vi.fn(),
  loadAccounts: vi.fn(),
  importAccounts: vi.fn(),
  apiGet: vi.fn(),
  changeLanguage: vi.fn(),
  accounts: [{ email: 'private@example.invalid', password: 'private-password' }],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US', changeLanguage: mocks.changeLanguage },
  }),
}));
vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../src/components/Layout/PageContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/store/accounts', () => ({
  useAccountsStore: Object.assign(() => mocks, { getState: () => mocks }),
}));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('../../src/api/client', () => ({ apiGet: (...args: unknown[]) => mocks.apiGet(...args) }));
vi.mock('../../src/apple/storeProof', () => ({
  StoreProofClient: { clearAll: (...args: unknown[]) => mocks.clearProof(...args) },
}));

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeEach(() => {
  vi.resetAllMocks();
  clearDiagnosticEvents();
  mocks.apiGet.mockResolvedValue({});
  mocks.clearAccounts.mockResolvedValue(undefined);
  mocks.clearProof.mockResolvedValue(undefined);
  mocks.loadAccounts.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('Settings reset and diagnostics', () => {
  it('waits for account work and retains reset ownership when another tab blocks deletion', async () => {
    vi.useFakeTimers();
    let finishAccount!: () => void;
    const active = withAccountAction(
      'private@example.invalid',
      createDiagnosticFlow('login'),
      () => new Promise<void>((resolve) => (finishAccount = resolve)),
    );
    let finishClear!: () => void;
    mocks.clearProof.mockImplementation(async (_flow, onBlocked) => {
      onBlocked();
      await new Promise<void>((resolve) => (finishClear = resolve));
    });
    render(<SettingsPage />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.data.button' })));
    expect(mocks.clearProof).not.toHaveBeenCalled();
    await act(async () => {
      finishAccount();
      await active;
    });
    expect(screen.getByRole('status')).toHaveTextContent('settings.data.closeOtherTabs');
    expect(screen.getByRole('button', { name: 'loading' })).toBeDisabled();
    expect(mocks.clearAccounts).not.toHaveBeenCalled();
    await expect(
      withAccountAction('another@example.invalid', createDiagnosticFlow('login'), async () => true),
    ).rejects.toMatchObject({ diagnostics: { reason: 'busy' } });
    await act(async () => finishClear());
    expect(mocks.clearAccounts).toHaveBeenCalledOnce();
    expect(mocks.addToast).toHaveBeenCalledWith('settings.data.cleared', 'success');
    expect(getDiagnosticEvents()).toEqual([
      expect.objectContaining({ stage: 'clear_data', outcome: 'success', reason: 'cleared' }),
    ]);
  });

  it('shows reset failures with a flow and leaves data controls usable for recovery', async () => {
    mocks.clearProof.mockRejectedValue(new Error('Storage unavailable'));
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.data.button' }));
    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith(expect.stringMatching(/^Storage unavailable\n\[flow: /), 'error'),
    );
    expect(screen.getByRole('button', { name: 'settings.data.button' })).toBeEnabled();
    expect(mocks.clearAccounts).not.toHaveBeenCalled();
  });

  it('exports only the bounded safe diagnostic events, not local accounts', async () => {
    let blob!: Blob;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((value: Blob) => {
        blob = value;
        return 'blob:diagnostics';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let filename = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      filename = this.download;
    });
    render(<SettingsPage />);
    await act(async () => undefined);
    clearDiagnosticEvents();
    const flow = createDiagnosticFlow('license');
    flow.log('purchase', 'failure', { httpStatus: 200, reason: 'terms_required', errorCode: '2042' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.diagnostics.export' }));
    const serialized = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const result = JSON.parse(serialized);
    expect(filename).toBe('asspp-diagnostics.json');
    expect(result).toMatchObject({
      schema: 1,
      events: [expect.objectContaining({ flowId: flow.id, reason: 'terms_required', httpStatus: 200 })],
    });
    expect(result.events).toHaveLength(1);
    expect(serialized).not.toContain('private@example.invalid');
    expect(serialized).not.toContain('private-password');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
  });
});
