import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddDownload from '../../src/components/Download/AddDownload';
import SearchPage from '../../src/components/Search/SearchPage';
import { useSearch } from '../../src/hooks/useSearch';
import { clearDiagnosticEvents, getDiagnosticEvents } from '../../src/utils/diagnostics';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  defaultCountry: 'US',
  lookupApp: vi.fn(),
  searchApps: vi.fn(),
  acquireLicense: vi.fn(),
  startDownload: vi.fn(),
  loadVersions: vi.fn(),
  toastDownloadError: vi.fn(),
  toastLicenseError: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state }: { children: React.ReactNode; to: string; state: { country: string } }) => (
    <a href={to} data-country={state.country}>
      {children}
    </a>
  ),
}));
vi.mock('../../src/components/Layout/PageContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ accounts: mocks.accounts }) }));
vi.mock('../../src/hooks/useDownloadAction', () => ({ useDownloadAction: () => mocks }));
vi.mock('../../src/store/settings', () => ({
  useSettingsStore: () => ({ defaultCountry: mocks.defaultCountry, defaultEntity: 'iPhone' }),
}));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (select: (value: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('../../src/api/search', () => ({
  lookupApp: (...args: unknown[]) => mocks.lookupApp(...args),
  searchApps: (...args: unknown[]) => mocks.searchApps(...args),
}));

const usAccount = { email: 'us@example.invalid', store: '143441', firstName: 'US', lastName: 'Account' } as Account;
const cnAccount = { email: 'cn@example.invalid', store: '143465', firstName: 'CN', lastName: 'Account' } as Account;
const usApp = {
  id: 123,
  bundleID: 'example.app',
  name: 'US app',
  artistName: 'Example',
  artworkUrl: '',
  version: '1.0',
  price: 0,
  averageUserRating: 4,
} as Software;
const cnApp = { ...usApp, id: 456, name: 'CN app' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function submitLookup() {
  fireEvent.change(screen.getByPlaceholderText('downloads.add.placeholder'), { target: { value: 'example.app' } });
  fireEvent.click(screen.getByRole('button', { name: 'downloads.add.lookup' }));
}

function selectCountry(country: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'regions.all' }), { target: { value: country } });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accounts = [usAccount, cnAccount];
  mocks.defaultCountry = 'US';
  mocks.lookupApp.mockResolvedValue(usApp);
  mocks.searchApps.mockResolvedValue([usApp]);
  mocks.loadVersions.mockResolvedValue({ versions: ['100', '200'] });
  mocks.acquireLicense.mockResolvedValue(undefined);
  mocks.startDownload.mockResolvedValue(true);
  useSearch.getState().clear();
  useSearch.getState().setSearchParam({ country: 'US', entity: 'iPhone' });
  clearDiagnosticEvents();
});

afterEach(() => cleanup());

describe('country-bound search navigation', () => {
  it('removes old links before attaching the new country to any result', async () => {
    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), { target: { value: 'app' } });
    fireEvent.click(screen.getByRole('button', { name: 'search.button' }));
    const link = await screen.findByRole('link', { name: /US app/ });
    expect(link).toHaveAttribute('data-country', 'US');
    selectCountry('CN');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(mocks.searchApps).toHaveBeenCalledTimes(1);
    mocks.searchApps.mockResolvedValueOnce([cnApp]);
    fireEvent.click(screen.getByRole('button', { name: 'search.button' }));
    expect(await screen.findByRole('link', { name: /CN app/ })).toHaveAttribute('data-country', 'CN');
    expect(mocks.searchApps).toHaveBeenLastCalledWith('app', 'CN', 'iPhone');
  });

  it('keeps a stale search completion from producing links in the new country', async () => {
    const old = deferred<Software[]>();
    mocks.searchApps.mockReturnValueOnce(old.promise);
    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), { target: { value: 'app' } });
    fireEvent.click(screen.getByRole('button', { name: 'search.button' }));
    selectCountry('CN');
    await act(async () => old.resolve([usApp]));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'regions.all' })).toHaveValue('CN');
    expect(mocks.searchApps).toHaveBeenCalledTimes(1);
  });
});

describe('country-bound download selection', () => {
  it('clears the completed app and selected versions before using another country account', async () => {
    render(<AddDownload />);
    submitLookup();
    await screen.findByText('US app');
    fireEvent.click(screen.getByRole('button', { name: 'downloads.add.selectVersion' }));
    const version = await screen.findByRole('option', { name: '100' });
    fireEvent.change(version.parentElement!, { target: { value: '100' } });
    selectCountry('CN');
    expect(screen.queryByText('US app')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '100' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'downloads.add.getLicense' })).not.toBeInTheDocument();
    expect(mocks.lookupApp).toHaveBeenCalledTimes(1);
    expect(mocks.acquireLicense).not.toHaveBeenCalled();
    mocks.lookupApp.mockResolvedValueOnce(cnApp);
    fireEvent.click(screen.getByRole('button', { name: 'downloads.add.lookup' }));
    await screen.findByText('CN app');
    fireEvent.click(screen.getByRole('button', { name: 'downloads.add.getLicense' }));
    await waitFor(() => expect(mocks.acquireLicense).toHaveBeenCalledWith(cnAccount, cnApp));
    expect(mocks.lookupApp).toHaveBeenLastCalledWith('example.app', 'CN');
    expect(mocks.accounts).toEqual([usAccount, cnAccount]);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let an invalidated lookup %s release a newer lookup guard',
    async (completion) => {
      const old = deferred<Software | null>();
      const next = deferred<Software | null>();
      mocks.lookupApp.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      render(<AddDownload />);
      submitLookup();
      expect(screen.getByRole('combobox', { name: 'regions.all' })).toBeEnabled();
      selectCountry('CN');
      fireEvent.click(screen.getByRole('button', { name: 'downloads.add.lookup' }));
      expect(mocks.lookupApp).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (completion === 'resolve') old.resolve(usApp);
        else old.reject(new Error('stale lookup failure'));
      });
      expect(screen.getByRole('button', { name: 'downloads.add.lookingUp' })).toBeDisabled();
      expect(screen.queryByText('US app')).not.toBeInTheDocument();
      expect(mocks.addToast).not.toHaveBeenCalled();
      expect(getDiagnosticEvents()).toContainEqual(
        expect.objectContaining({ stage: 'version_lookup', outcome: 'cancelled' }),
      );
      await act(async () => next.resolve(cnApp));
      expect(screen.getByText('CN app')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'downloads.add.lookup' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'downloads.add.getLicense' }));
      await waitFor(() => expect(mocks.acquireLicense).toHaveBeenCalledWith(cnAccount, cnApp));
    },
  );

  it('invalidates a pending lookup when the automatic account country changes', async () => {
    const old = deferred<Software | null>();
    mocks.lookupApp.mockReturnValueOnce(old.promise);
    const view = render(<AddDownload />);
    submitLookup();
    mocks.accounts = [cnAccount, usAccount];
    view.rerender(<AddDownload />);
    expect(screen.getByRole('combobox', { name: 'regions.all' })).toHaveValue('CN');
    await act(async () => old.resolve(usApp));
    expect(screen.queryByText('US app')).not.toBeInTheDocument();
    expect(mocks.lookupApp).toHaveBeenCalledTimes(1);
  });

  it('does not permit country changes while a license operation is in progress', async () => {
    const license = deferred<void>();
    mocks.acquireLicense.mockReturnValueOnce(license.promise);
    render(<AddDownload />);
    submitLookup();
    await screen.findByText('US app');
    fireEvent.click(screen.getByRole('button', { name: 'downloads.add.getLicense' }));
    expect(screen.getByRole('combobox', { name: 'regions.all' })).toBeDisabled();
    await act(async () => license.resolve());
    expect(screen.getByRole('combobox', { name: 'regions.all' })).toBeEnabled();
    expect(mocks.acquireLicense).toHaveBeenCalledTimes(1);
  });

  it('discards a lookup failure after leaving the page', async () => {
    const old = deferred<Software | null>();
    mocks.lookupApp.mockReturnValueOnce(old.promise);
    const view = render(<AddDownload />);
    submitLookup();
    view.unmount();
    await act(async () => old.reject(new Error('late failure')));
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(getDiagnosticEvents()).toContainEqual(
      expect.objectContaining({ stage: 'version_lookup', outcome: 'cancelled' }),
    );
  });
});
