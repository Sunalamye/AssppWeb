import { create } from 'zustand';
import { deleteDB, openDB } from 'idb';
import { attachDiagnosticId, createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';
import { missingAccount } from '../utils/accountActions';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { Account } from '../types';

const DB_NAME = 'asspp-accounts';
const STORE_NAME = 'accounts';
let dbPromise: Promise<IDBPDatabase> | undefined;
let loadGeneration = 0;
let clearing = false;
const pending = new Set<Promise<unknown>>();

function getDB(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;
  const opening = openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'email' });
    },
    blocking() {
      void opening.then((db) => db.close());
      if (dbPromise === opening) dbPromise = undefined;
      loadGeneration++;
      useAccountsStore.setState({ accounts: [], loading: false });
    },
    terminated() {
      if (dbPromise === opening) dbPromise = undefined;
    },
  });
  dbPromise = opening;
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = undefined;
  });
  return opening;
}

async function writeAccounts(
  change: (transaction: IDBPTransaction<unknown, ['accounts'], 'readwrite'>) => Promise<unknown>,
): Promise<Account[]> {
  const transaction = (await getDB()).transaction(STORE_NAME, 'readwrite');
  try {
    await change(transaction);
    const accounts = await transaction.store.getAll();
    await transaction.done;
    return accounts;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* A failed request may have already aborted the transaction. */
    }
    // Request failures and transaction.done reject separately. Observe both.
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

async function stored<T>(
  flow: DiagnosticFlow,
  stage: 'store_state' | 'account_save',
  action: () => Promise<T>,
): Promise<T> {
  if (clearing) {
    const error = new Error('Local account data is being cleared. Please wait.');
    flow.log(stage, 'blocked', { reason: 'busy' });
    throw attachDiagnosticId(error, flow.id);
  }
  flow.log(stage, 'start');
  const run = Promise.resolve().then(action);
  pending.add(run);
  try {
    const result = await run;
    flow.log(stage, 'success');
    return result;
  } catch (error) {
    const details = errorDiagnosticDetails(error);
    if (details.reason === 'unknown') {
      details.reason = 'storage';
      if (error && typeof error === 'object') {
        try {
          Object.assign(error, { diagnostics: details });
        } catch {
          /* Preserve a frozen error. */
        }
      }
    }
    flow.log(stage, 'failure', details);
    throw attachDiagnosticId(error, flow.id);
  } finally {
    pending.delete(run);
  }
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: (flow?: DiagnosticFlow) => Promise<void>;
  readAccount: (email: string, flow?: DiagnosticFlow) => Promise<Account | undefined>;
  addAccount: (account: Account, flow?: DiagnosticFlow) => Promise<void>;
  removeAccount: (email: string, flow?: DiagnosticFlow) => Promise<void>;
  updateAccount: (account: Account, flow?: DiagnosticFlow) => Promise<void>;
  importAccounts: (accounts: Account[], overwrite: boolean, flow?: DiagnosticFlow) => Promise<void>;
  clearAccounts: (flow?: DiagnosticFlow, onBlocked?: () => void) => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set) => ({
  accounts: [],
  loading: true,

  loadAccounts: async (flow = createDiagnosticFlow('account')) => {
    const generation = ++loadGeneration;
    set({ loading: true });
    try {
      const accounts = await stored(flow, 'store_state', async () => (await getDB()).getAll(STORE_NAME));
      if (generation === loadGeneration) set({ accounts });
    } finally {
      if (generation === loadGeneration) set({ loading: false });
    }
  },

  readAccount: async (email, flow = createDiagnosticFlow('account')) =>
    stored(flow, 'store_state', async () => (await getDB()).get(STORE_NAME, email)),

  addAccount: async (account, flow = createDiagnosticFlow('account')) => {
    await stored(flow, 'account_save', async () => {
      const accounts = await writeAccounts((transaction) => transaction.store.put(account));
      loadGeneration++;
      set({ accounts, loading: false });
    });
  },

  removeAccount: async (email, flow = createDiagnosticFlow('account')) => {
    await stored(flow, 'account_save', async () => {
      const accounts = await writeAccounts((transaction) => transaction.store.delete(email));
      loadGeneration++;
      set({ accounts, loading: false });
    });
  },

  updateAccount: async (account, flow = createDiagnosticFlow('account')) => {
    await stored(flow, 'account_save', async () => {
      const accounts = await writeAccounts(async (transaction) => {
        if (!(await transaction.store.get(account.email))) throw missingAccount(flow);
        await transaction.store.put(account);
      });
      loadGeneration++;
      set({ accounts, loading: false });
    });
  },

  importAccounts: async (accounts, overwrite, flow = createDiagnosticFlow('settings')) => {
    await stored(flow, 'account_save', async () => {
      const updated = await writeAccounts(async (transaction) => {
        for (const account of accounts) {
          if (overwrite || !(await transaction.store.get(account.email))) await transaction.store.put(account);
        }
      });
      loadGeneration++;
      set({ accounts: updated, loading: false });
    });
  },

  clearAccounts: async (flow = createDiagnosticFlow('settings'), onBlocked) => {
    if (clearing) throw new Error('Account data is already being cleared');
    clearing = true;
    loadGeneration++;
    flow.log('clear_data', 'start');
    try {
      await Promise.allSettled([...pending]);
      const opening = dbPromise;
      dbPromise = undefined;
      if (opening) (await opening.catch(() => undefined))?.close();
      await deleteDB(DB_NAME, {
        blocked() {
          // The delete request cannot be cancelled; retain the reset lock until it finishes.
          flow.log('clear_data', 'blocked', { reason: 'busy' });
          onBlocked?.();
        },
      });
      set({ accounts: [], loading: false });
      flow.log('clear_data', 'success', { reason: 'cleared' });
    } catch (error) {
      flow.log('clear_data', 'failure', { reason: 'storage' });
      throw attachDiagnosticId(error, flow.id);
    } finally {
      clearing = false;
    }
  },
}));

// Loading failure remains observable without becoming an unhandled rejection.
void useAccountsStore
  .getState()
  .loadAccounts()
  .catch(() => undefined);
