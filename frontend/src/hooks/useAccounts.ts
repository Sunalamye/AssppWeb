import { useAccountsStore } from '../store/accounts';

export function useAccounts() {
  const { accounts, loading, loadAccounts, readAccount, addAccount, removeAccount, updateAccount, clearAccounts } =
    useAccountsStore();

  function getAccount(email: string) {
    return accounts.find((a) => a.email === email);
  }

  return {
    accounts,
    loading,
    loadAccounts,
    readAccount,
    addAccount,
    removeAccount,
    updateAccount,
    clearAccounts,
    getAccount,
  };
}
