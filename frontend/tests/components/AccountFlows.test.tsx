import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddAccountForm from '../../src/components/Account/AddAccountForm';
import AccountDetail from '../../src/components/Account/AccountDetail';
import { AuthenticationError } from '../../src/apple/authenticate';
import { clearDiagnosticEvents, getDiagnosticEvents } from '../../src/utils/diagnostics';
import type { Account } from '../../src/types';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  constructor: vi.fn(),
  addAccount: vi.fn(),
  updateAccount: vi.fn(),
  readAccount: vi.fn(),
  removeAccount: vi.fn(),
  loadAccounts: vi.fn(),
  addToast: vi.fn(),
  navigate: vi.fn(),
  params: { email: 'first%40example.invalid' },
  accounts: [] as Account[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useParams: () => mocks.params }));
vi.mock('../../src/components/Layout/PageContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({ ...mocks, loading: false }),
}));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('../../src/apple/authenticate', () => ({
  Authenticator: class {
    constructor(...args: unknown[]) {
      mocks.constructor(...args);
    }
    authenticate(...args: unknown[]) {
      return mocks.authenticate(...args);
    }
  },
  AuthenticationError: class extends Error {
    constructor(
      message: string,
      public readonly codeRequired = false,
    ) {
      super(message);
    }
  },
}));

const first: Account = {
  email: 'first@example.invalid',
  password: 'synthetic-private-password',
  appleId: 'first@example.invalid',
  deviceIdentifier: '001122AABBCC',
  store: '143441',
  storeFront: '143441-1,32',
  firstName: 'First',
  lastName: 'Account',
  passwordToken: 'synthetic-private-token',
  directoryServicesIdentifier: '123',
  cookies: [],
};
const second = { ...first, email: 'second@example.invalid', deviceIdentifier: 'FFEEDD001122' };

beforeEach(() => {
  vi.resetAllMocks();
  clearDiagnosticEvents();
  mocks.params.email = encodeURIComponent(first.email);
  mocks.accounts = [first, second];
  mocks.loadAccounts.mockResolvedValue(undefined);
  mocks.addAccount.mockResolvedValue(undefined);
  mocks.updateAccount.mockResolvedValue(undefined);
  mocks.removeAccount.mockResolvedValue(undefined);
  mocks.readAccount.mockImplementation(async (email: string) =>
    mocks.accounts.find((account) => account.email === email),
  );
  mocks.authenticate.mockResolvedValue(first);
});
afterEach(cleanup);

function fillAddForm() {
  fireEvent.change(screen.getByLabelText('accounts.addForm.email'), { target: { value: first.email } });
  fireEvent.change(screen.getByLabelText('accounts.addForm.password'), { target: { value: first.password } });
  return screen.getByRole('button', { name: 'accounts.addForm.signIn' }).closest('form')!;
}

describe('account view continuations', () => {
  it('coalesces same-tick form submits into one login and one save', async () => {
    let resolve!: (account: Account) => void;
    mocks.authenticate.mockImplementation(() => new Promise((done) => (resolve = done)));
    render(<AddAccountForm />);
    const form = fillAddForm();
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    await act(async () => resolve(first));
    expect(mocks.constructor).toHaveBeenCalledOnce();
    expect(mocks.addAccount).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/accounts');
  });

  it('retains the authenticator and flow for the verification-code submission', async () => {
    mocks.authenticate.mockRejectedValueOnce(new AuthenticationError('Verification required', true));
    render(<AddAccountForm />);
    fireEvent.submit(fillAddForm());
    const code = await screen.findByLabelText('accounts.addForm.code');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'accounts.addForm.verify' }));
    await waitFor(() => expect(mocks.addAccount).toHaveBeenCalledOnce());
    expect(mocks.constructor).toHaveBeenCalledOnce();
    expect(mocks.authenticate.mock.calls[0][2]).toBeUndefined();
    expect(mocks.authenticate.mock.calls[1][2]).toBe('123456');
    expect(mocks.authenticate.mock.calls[1][5]).toBe(mocks.authenticate.mock.calls[0][5]);
    const history = JSON.stringify(getDiagnosticEvents());
    for (const secret of [first.email, first.password, first.passwordToken, '123456'])
      expect(history).not.toContain(secret);
  });

  it('resets a pending verification when the sign-in identity changes', async () => {
    mocks.authenticate.mockRejectedValueOnce(new AuthenticationError('Verification required', true));
    render(<AddAccountForm />);
    fireEvent.submit(fillAddForm());
    await screen.findByLabelText('accounts.addForm.code');
    fireEvent.change(screen.getByLabelText('accounts.addForm.email'), { target: { value: second.email } });
    expect(screen.queryByLabelText('accounts.addForm.code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'accounts.addForm.signIn' }));
    await waitFor(() => expect(mocks.addAccount).toHaveBeenCalledOnce());
    expect(mocks.constructor).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate.mock.calls[1][2]).toBeUndefined();
    expect(mocks.authenticate.mock.calls[1][5].id).not.toBe(mocks.authenticate.mock.calls[0][5].id);
  });

  it('uses the new account after a route change and never reuses the previous 2FA session', async () => {
    mocks.authenticate
      .mockRejectedValueOnce(new AuthenticationError('Verification required', true))
      .mockResolvedValue(second);
    const { rerender } = render(<AccountDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'accounts.detail.reauth' }));
    await screen.findByLabelText('accounts.detail.code');
    mocks.params.email = encodeURIComponent(second.email);
    rerender(<AccountDetail />);
    expect(screen.queryByLabelText('accounts.detail.code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'accounts.detail.reauth' }));
    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledOnce());
    expect(mocks.constructor).toHaveBeenNthCalledWith(
      1,
      first.deviceIdentifier,
      first.cookies,
      expect.any(Object),
      first,
    );
    expect(mocks.constructor).toHaveBeenNthCalledWith(
      2,
      second.deviceIdentifier,
      second.cookies,
      expect.any(Object),
      second,
    );
    expect(mocks.authenticate.mock.calls[1].slice(0, 3)).toEqual([second.email, second.password, undefined]);
    expect(mocks.updateAccount).toHaveBeenCalledWith(second, expect.any(Object));
  });

  it('does not save an old route result after navigation while authentication is pending', async () => {
    let resolve!: (account: Account) => void;
    mocks.authenticate.mockImplementation(() => new Promise((done) => (resolve = done)));
    const { rerender } = render(<AccountDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'accounts.detail.reauth' }));
    await waitFor(() => expect(mocks.authenticate).toHaveBeenCalledOnce());
    mocks.params.email = encodeURIComponent(second.email);
    rerender(<AccountDetail />);
    await act(async () => resolve(first));
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalledWith('accounts.detail.reauthSuccess', 'success');
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'action', outcome: 'cancelled' })]),
    );
  });

  it('reports a failed account save with its flow and does not navigate as if it succeeded', async () => {
    mocks.addAccount.mockRejectedValue(new Error('Storage unavailable'));
    render(<AddAccountForm />);
    fireEvent.submit(fillAddForm());
    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith(expect.stringMatching(/^Storage unavailable\n\[flow: /), 'error'),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
