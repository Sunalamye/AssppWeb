import { describe, it, expect, beforeEach, vi } from 'vitest';
import { deleteDB, openDB } from 'idb';
import { useAccountsStore } from '../../src/store/accounts';
import { createDiagnosticFlow, getDiagnosticEvents, clearDiagnosticEvents } from '../../src/utils/diagnostics';
import type { Account } from '../../src/types';

const mockAccount: Account = {
  email: 'test@example.com',
  password: 'secret',
  appleId: 'test@example.com',
  store: '143441',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token123',
  directoryServicesIdentifier: 'dsid123',
  cookies: [],
  deviceIdentifier: '001122AABBCC',
};

describe('store/accounts', () => {
  beforeEach(async () => {
    await useAccountsStore.getState().clearAccounts();
    await useAccountsStore.getState().loadAccounts();
    clearDiagnosticEvents();
  });

  it('should start with empty accounts', async () => {
    await useAccountsStore.getState().loadAccounts();
    expect(useAccountsStore.getState().accounts).toHaveLength(0);
  });

  it('should add an account', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    const accounts = useAccountsStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('test@example.com');
    expect(accounts[0].firstName).toBe('Test');
  });

  it('should persist account to IndexedDB and reload', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().loadAccounts();
    const accounts = useAccountsStore.getState().accounts;
    expect(accounts.find((a) => a.email === 'test@example.com')).toBeDefined();
  });

  it('should remove an account', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    expect(useAccountsStore.getState().accounts).toHaveLength(1);

    await useAccountsStore.getState().removeAccount('test@example.com');
    expect(useAccountsStore.getState().accounts).toHaveLength(0);
  });

  it('should update an account', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);

    const updated = {
      ...mockAccount,
      firstName: 'Updated',
      passwordToken: 'newtoken',
    };
    await useAccountsStore.getState().updateAccount(updated);

    const accounts = useAccountsStore.getState().accounts;
    expect(accounts[0].firstName).toBe('Updated');
    expect(accounts[0].passwordToken).toBe('newtoken');
  });

  it('should handle multiple accounts', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().addAccount({
      ...mockAccount,
      email: 'other@example.com',
      firstName: 'Other',
    });

    expect(useAccountsStore.getState().accounts).toHaveLength(2);
  });

  it('should replace account with same email on add', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().addAccount({
      ...mockAccount,
      firstName: 'Replaced',
    });

    const accounts = useAccountsStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].firstName).toBe('Replaced');
  });

  it('does not resurrect a deleted account through a late session write', async () => {
    const state = useAccountsStore.getState();
    await state.addAccount(mockAccount);
    await state.removeAccount(mockAccount.email);
    await expect(state.updateAccount({ ...mockAccount, passwordToken: 'late-token' })).rejects.toMatchObject({
      diagnostics: { reason: 'not_found' },
    });
    await state.loadAccounts();
    expect(useAccountsStore.getState().accounts).toEqual([]);
  });

  it('reads current persisted state instead of a stale in-memory snapshot', async () => {
    const state = useAccountsStore.getState();
    await state.addAccount(mockAccount);
    const external = await openDB('asspp-accounts', 1);
    await external.put('accounts', { ...mockAccount, passwordToken: 'other-tab-token' });
    external.close();
    expect(useAccountsStore.getState().accounts[0].passwordToken).toBe(mockAccount.passwordToken);
    expect((await state.readAccount(mockAccount.email))?.passwordToken).toBe('other-tab-token');
  });

  it('drains an in-flight write before deleting and reopens a usable empty database', async () => {
    const state = useAccountsStore.getState();
    const adding = state.addAccount(mockAccount);
    const clearing = state.clearAccounts();
    await Promise.all([adding, clearing]);
    await state.loadAccounts();
    expect(useAccountsStore.getState().accounts).toEqual([]);
    await state.addAccount(mockAccount);
    expect(await state.readAccount(mockAccount.email)).toEqual(mockAccount);
  });

  it('closes its cached connection when another tab deletes the database', async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await deleteDB('asspp-accounts');
    expect(useAccountsStore.getState().accounts).toEqual([]);
    await useAccountsStore.getState().addAccount(mockAccount);
    expect(useAccountsStore.getState().accounts).toHaveLength(1);
  });

  it('keeps deletion pending and blocks writes while a legacy tab holds the database', async () => {
    const state = useAccountsStore.getState();
    await state.addAccount(mockAccount);
    const legacyTab = await openDB('asspp-accounts', 1);
    let unblock!: () => void;
    const wasBlocked = new Promise<void>((resolve) => (unblock = resolve));
    const onBlocked = vi.fn(unblock);
    let finished = false;
    const clearing = state.clearAccounts(createDiagnosticFlow('settings'), onBlocked).then(() => {
      finished = true;
    });
    await wasBlocked;
    expect(finished).toBe(false);
    await expect(state.addAccount(mockAccount)).rejects.toThrow('cleared');
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'clear_data', outcome: 'blocked', reason: 'busy' })]),
    );
    legacyTab.close();
    await clearing;
    expect(onBlocked).toHaveBeenCalledOnce();
    await state.loadAccounts();
    expect(useAccountsStore.getState().accounts).toEqual([]);
  });

  it('imports atomically and rolls back earlier records if a later record cannot be stored', async () => {
    const state = useAccountsStore.getState();
    await state.addAccount(mockAccount);
    const invalid = { ...mockAccount, email: 'bad@example.invalid', unsupported: () => undefined } as Account;
    await expect(
      state.importAccounts([{ ...mockAccount, email: 'new@example.invalid' }, invalid], false),
    ).rejects.toBeDefined();
    await state.loadAccounts();
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
    expect(JSON.stringify(getDiagnosticEvents())).not.toContain(mockAccount.passwordToken);
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'account_save', outcome: 'failure', reason: 'storage' }),
      ]),
    );
  });

  it('skips or replaces conflicts according to the explicit import decision', async () => {
    const state = useAccountsStore.getState();
    await state.addAccount(mockAccount);
    const updated = { ...mockAccount, passwordToken: 'imported-token' };
    await state.importAccounts([updated], false);
    expect((await state.readAccount(mockAccount.email))?.passwordToken).toBe(mockAccount.passwordToken);
    await state.importAccounts([updated], true);
    expect((await state.readAccount(mockAccount.email))?.passwordToken).toBe('imported-token');
  });

  it('clears a failed open promise and loading state so later attempts can recover', async () => {
    const state = useAccountsStore.getState();
    await state.clearAccounts();
    const opening = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new Error('Synthetic unavailable DB');
    });
    await expect(state.loadAccounts()).rejects.toThrow('Synthetic unavailable DB');
    expect(useAccountsStore.getState().loading).toBe(false);
    opening.mockRestore();
    await state.addAccount(mockAccount);
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });

  it('observes both request and transaction rejections after an asynchronous abort', async () => {
    const nativePut = IDBObjectStore.prototype.put;
    const putting = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (value, key) {
      const request = nativePut.call(this, value, key);
      queueMicrotask(() => this.transaction.abort());
      return request;
    });
    await expect(useAccountsStore.getState().addAccount(mockAccount)).rejects.toMatchObject({ name: 'AbortError' });
    putting.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAccountsStore.getState().accounts).toEqual([]);
    await useAccountsStore.getState().addAccount(mockAccount);
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });
});
