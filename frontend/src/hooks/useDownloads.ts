import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDownloadsStore } from '../store/downloads';
import { useToastStore } from '../store/toast';
import { useAccounts } from './useAccounts';
import { accountHash } from '../utils/account';
import { getErrorMessage } from '../utils/error';
import { attachDiagnosticId, createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';

export function useDownloads() {
  const { tasks, loading, setAccountHashes, fetchTasks, startDownload, pauseDownload, resumeDownload, deleteDownload } =
    useDownloadsStore();
  const { accounts } = useAccounts();
  const addToast = useToastStore((state) => state.addToast);
  const { t } = useTranslation();
  const hashesRef = useRef<string | null>(null);
  const [hashToEmail, setHashToEmail] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const flow = createDiagnosticFlow('download');
    (async () => {
      // Calculate original hashes preserving the order corresponding to 'accounts'
      const hashes = await Promise.all(accounts.map((a) => accountHash(a)));
      // Use slice() before sort() so we don't mutate the original 'hashes' array
      const key = hashes.slice().sort().join(',');
      if (cancelled || key === hashesRef.current) return;
      hashesRef.current = key;

      const map: Record<string, string> = {};
      for (let i = 0; i < accounts.length; i++) {
        // Now hashes[i] correctly maps to accounts[i]
        map[hashes[i]] = accounts[i].email;
      }
      setHashToEmail(map);

      setAccountHashes(hashes);
      // Fetch immediately after hashes are set so downloads appear on first visit
      await fetchTasks(flow);
    })().catch((error) => {
      if (cancelled) return;
      flow.log('task_state', 'failure', errorDiagnosticDetails(error));
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('toast.title.downloadFailed')), 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, setAccountHashes, fetchTasks]);

  return {
    tasks,
    loading,
    hashToEmail,
    fetchTasks,
    startDownload,
    pauseDownload,
    resumeDownload,
    deleteDownload,
  };
}
