import { useTranslation } from 'react-i18next';
import { useAccounts } from './useAccounts';
import { useToastStore } from '../store/toast';
import { useDownloadsStore } from '../store/downloads';
import { getDownloadInfo } from '../apple/download';
import { purchaseApp, PurchaseError } from '../apple/purchase';
import { authenticate, AuthenticationError } from '../apple/authenticate';
import { listVersions } from '../apple/versionFinder';
import { getVersionMetadata } from '../apple/versionLookup';
import { apiPost, apiGet } from '../api/client';
import { accountHash } from '../utils/account';
import { getErrorMessage } from '../utils/error';
import { getAccountContext } from '../utils/toast';
import { missingAccount, withAccountAction } from '../utils/accountActions';
import { attachDiagnosticId, createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { Account, Software } from '../types';

/** Shared account operations serialize protocol calls and their resulting state writes. */
export function useDownloadAction() {
  const { readAccount, updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function refreshTasks(flow: DiagnosticFlow) {
    flow.log('task_state', 'start', { endpoint: 'backend_downloads' });
    try {
      await fetchTasks(flow);
      flow.log('task_state', 'success', { endpoint: 'backend_downloads' });
    } catch (error) {
      // A failed list refresh must not change the already completed enqueue result.
      flow.log('task_state', 'failure', errorDiagnosticDetails(error));
    }
  }

  async function runForAccount<T>(
    kind: 'license' | 'download' | 'versions',
    account: Account,
    action: (current: Account, flow: DiagnosticFlow) => Promise<T>,
  ): Promise<T> {
    const flow = createDiagnosticFlow(kind);
    flow.log('action', 'start');
    try {
      const result = await withAccountAction(account.email, flow, async () => {
        const current = await readAccount(account.email, flow);
        if (!current) throw missingAccount(flow);
        return action(current, flow);
      });
      flow.log('action', result === false ? 'blocked' : 'success');
      return result;
    } catch (error) {
      flow.log('action', 'failure', errorDiagnosticDetails(error));
      throw attachDiagnosticId(error, flow.id);
    }
  }

  async function startDownload(account: Account, app: Software, versionId?: string) {
    return runForAccount('download', account, async (current, flow) => {
      const ctx = getAccountContext(current, t);
      const appName = app.name;
      flow.log('settings', 'start');
      try {
        const settings = await apiGet<{ maxDownloadMB: number }>('/api/settings');
        flow.log('settings', 'success');
        if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
          const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
          if (sizeMB > settings.maxDownloadMB) {
            addToast(
              t('toast.downloadLimit.message', { appName, size: sizeMB.toFixed(2), limit: settings.maxDownloadMB }),
              'error',
              t('toast.title.downloadLimit'),
            );
            return false;
          }
        }
      } catch (error) {
        // The server still enforces its limit. Record the failed read before continuing.
        flow.log('settings', 'failure', errorDiagnosticDetails(error));
        flow.log('settings', 'transition', { reason: 'fallback' });
      }

      const { output, updatedCookies } = await getDownloadInfo(current, app, versionId, flow);
      await updateAccount({ ...current, cookies: updatedCookies }, flow);
      const hash = await accountHash(current);
      flow.log('download_enqueue', 'start', { endpoint: 'backend_downloads' });
      try {
        await apiPost(
          '/api/downloads',
          {
            software: { ...app, version: output.bundleShortVersionString },
            accountHash: hash,
            downloadURL: output.downloadURL,
            sinfs: output.sinfs,
            iTunesMetadata: output.iTunesMetadata,
          },
          { 'X-Asspp-Flow-Id': flow.id },
        );
        flow.log('download_enqueue', 'success', { endpoint: 'backend_downloads' });
      } catch (error) {
        flow.log('download_enqueue', 'failure', errorDiagnosticDetails(error));
        // A lost response may hide a successfully created task. Never resend automatically.
        flow.log('task_state', 'transition', { reason: 'fallback' });
        await refreshTasks(flow);
        const failure = new Error(
          getErrorMessage(error, t('toast.title.downloadFailed')) + '\n' + t('errors.download.enqueueUncertain'),
        );
        Object.assign(failure, { diagnostics: errorDiagnosticDetails(error) });
        throw failure;
      }
      await refreshTasks(flow);
      addToast(t('toast.msg', { appName, ...ctx }), 'info', t('toast.title.downloadStarted'));
      return true;
    });
  }

  async function acquireLicense(account: Account, app: Software) {
    return runForAccount('license', account, async (current, flow) => {
      if ((app.price ?? 0) > 0) {
        flow.log('purchase', 'blocked', { reason: 'paid_app' });
        throw new PurchaseError(t('errors.purchase.paidNotSupported'));
      }
      const ctx = getAccountContext(current, t);
      flow.log('account_refresh', 'start');
      let renewed: Account;
      try {
        renewed = await authenticate(
          current.email,
          current.password,
          undefined,
          current.cookies,
          current.deviceIdentifier,
          undefined,
          undefined,
          flow,
          current,
        );
        flow.log('account_refresh', 'success');
      } catch (error) {
        flow.log('account_refresh', 'failure', errorDiagnosticDetails(error));
        if (error instanceof AuthenticationError && error.codeRequired) {
          throw new AuthenticationError(t('errors.purchase.verificationRequired'), true);
        }
        throw error;
      }
      await updateAccount(renewed, flow);
      const result = await purchaseApp(renewed, app, flow);
      await updateAccount({ ...renewed, cookies: result.updatedCookies }, flow);
      addToast(
        t('toast.msg', { appName: app.name, ...ctx }),
        'success',
        result.alreadyOwned ? t('toast.title.licenseOwned') : t('toast.title.licenseSuccess'),
      );
    });
  }

  async function loadVersions(account: Account, app: Software) {
    return runForAccount('versions', account, async (current, flow) => {
      const result = await listVersions(current, app, flow);
      await updateAccount({ ...current, cookies: result.updatedCookies }, flow);
      return result;
    });
  }

  async function loadVersionMetadata(account: Account, app: Software, versionId: string) {
    return runForAccount('versions', account, async (current, flow) => {
      const result = await getVersionMetadata(current, app, versionId, flow);
      await updateAccount({ ...current, cookies: result.updatedCookies }, flow);
      return result;
    });
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.downloadFailed')),
      }),
      'error',
      t('toast.title.downloadFailed'),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.licenseFailed')),
      }),
      'error',
      t('toast.title.licenseFailed'),
    );
  }

  return { startDownload, acquireLicense, loadVersions, loadVersionMetadata, toastDownloadError, toastLicenseError };
}
