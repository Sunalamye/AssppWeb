import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import PageContainer from '../Layout/PageContainer';
import Modal from '../common/Modal';
import { useActionGuard } from '../../hooks/useActionGuard';
import { useAccountsStore } from '../../store/accounts';
import { useToastStore } from '../../store/toast';
import { apiGet } from '../../api/client';
import { encryptData, decryptData } from '../../utils/crypto';
import { getErrorMessage } from '../../utils/error';
import { withAccountsPaused } from '../../utils/accountActions';
import {
  attachDiagnosticId,
  clearDiagnosticEvents,
  createDiagnosticFlow,
  errorDiagnosticDetails,
  getDiagnosticEvents,
} from '../../utils/diagnostics';
import { countryCodeMap } from '../../apple/config';
import { StoreProofClient } from '../../apple/storeProof';
import type { Account } from '../../types';
import type { DiagnosticFlow } from '../../utils/diagnostics';

interface ServerInfo {
  uptime?: number;
  buildCommit?: string;
  buildDate?: string;
  port?: number;
  dataDir?: string;
  publicBaseUrl?: string;
  disableHttpsRedirect?: boolean;
  autoCleanupDays?: number;
  autoCleanupMaxMB?: number;
  maxDownloadMB?: number;
  downloadThreads?: number;
}

const entityTypes = [
  { value: 'software', label: 'iPhone' },
  { value: 'iPadSoftware', label: 'iPad' },
];

function localSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function isImportAccount(value: unknown): value is Account {
  if (!value || typeof value !== 'object') return false;
  const account = value as Record<string, unknown>;
  if (
    ![
      'email',
      'password',
      'appleId',
      'store',
      'firstName',
      'lastName',
      'passwordToken',
      'directoryServicesIdentifier',
      'deviceIdentifier',
    ].every((key) => typeof account[key] === 'string')
  )
    return false;
  if (!String(account.email).trim() || !/^[a-fA-F0-9]{12}$/.test(String(account.deviceIdentifier))) return false;
  return (
    Array.isArray(account.cookies) &&
    account.cookies.every(
      (cookie) =>
        cookie &&
        typeof cookie === 'object' &&
        typeof cookie.name === 'string' &&
        typeof cookie.value === 'string' &&
        typeof cookie.path === 'string' &&
        typeof cookie.secure === 'boolean' &&
        typeof cookie.httpOnly === 'boolean',
    )
  );
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { loadAccounts, importAccounts, clearAccounts } = useAccountsStore();
  const addToast = useToastStore((s) => s.addToast);
  const actionGuard = useActionGuard();

  const [country, setCountry] = useState(() => localSetting('asspp-default-country', 'US'));
  const [entity, setEntity] = useState(() => localSetting('asspp-default-entity', 'software'));
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [clearingData, setClearingData] = useState(false);
  const [clearBlocked, setClearBlocked] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const importFlow = useRef<DiagnosticFlow | null>(null);
  const importRead = useRef(0);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirmPassword, setExportConfirmPassword] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [importFileData, setImportFileData] = useState('');

  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [pendingAccounts, setPendingAccounts] = useState<Account[]>([]);
  const [conflictStats, setConflictStats] = useState({ conflict: 0, new: 0 });

  useEffect(() => {
    const flow = createDiagnosticFlow('settings');
    flow.log('settings', 'start');
    try {
      localStorage.setItem('asspp-default-country', country);
      flow.log('settings', 'success');
    } catch {
      flow.log('settings', 'failure', { reason: 'storage' });
    }
  }, [country]);

  useEffect(() => {
    const flow = createDiagnosticFlow('settings');
    flow.log('settings', 'start');
    try {
      localStorage.setItem('asspp-default-entity', entity);
      flow.log('settings', 'success');
    } catch {
      flow.log('settings', 'failure', { reason: 'storage' });
    }
  }, [entity]);

  useEffect(() => {
    const flow = createDiagnosticFlow('settings');
    flow.log('settings', 'start');
    apiGet<ServerInfo>('/api/settings')
      .then((info) => {
        setServerInfo(info);
        flow.log('settings', 'success');
      })
      .catch((error) => {
        setServerInfo(null);
        flow.log('settings', 'failure', errorDiagnosticDetails(error));
      });
  }, []);

  const sortedCountries = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const handleExport = async () => {
    if (!actionGuard.begin('settings')) return;
    const flow = createDiagnosticFlow('settings');
    flow.log('action', 'start');
    setDataBusy(true);
    try {
      if (exportPassword !== exportConfirmPassword) {
        flow.log('action', 'blocked', { reason: 'invalid_request' });
        addToast(t('settings.data.passwordMismatch'), 'error');
        return;
      }
      await withAccountsPaused(flow, async () => {
        await loadAccounts(flow);
        const encrypted = await encryptData(useAccountsStore.getState().accounts, exportPassword);
        const url = URL.createObjectURL(new Blob([encrypted], { type: 'text/plain' }));
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = 'asspp-accounts.enc';
          a.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      setExportModalOpen(false);
      setExportPassword('');
      setExportConfirmPassword('');
      flow.log('action', 'success');
      addToast(t('settings.data.exportSuccess'), 'success');
    } catch (error) {
      flow.log('action', 'failure', errorDiagnosticDetails(error));
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.exportFailed')), 'error');
    } finally {
      setDataBusy(false);
      actionGuard.end();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const selection = ++importRead.current;
    const flow = createDiagnosticFlow('settings');
    flow.log('settings', 'start');
    const reader = new FileReader();
    reader.onload = (event) => {
      if (selection !== importRead.current) {
        flow.log('settings', 'cancelled', { reason: 'cancelled' });
        return;
      }
      setImportFileData(String(event.target?.result ?? ''));
      setImportModalOpen(true);
      flow.log('settings', 'success');
    };
    reader.onerror = () => {
      flow.log('settings', 'failure', { reason: 'storage' });
      addToast(t('settings.data.importFailed') + '\n[flow: ' + flow.id + ']', 'error');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = async () => {
    if (!actionGuard.begin('settings')) return;
    const flow = createDiagnosticFlow('settings');
    importFlow.current = flow;
    flow.log('action', 'start');
    setDataBusy(true);
    try {
      let parsed: unknown;
      try {
        parsed = await decryptData(importFileData, importPassword);
      } catch {
        const error = new Error(t('settings.data.incorrectPassword'));
        Object.assign(error, { diagnostics: { reason: 'access_denied' } });
        throw error;
      }
      if (
        !Array.isArray(parsed) ||
        !parsed.length ||
        !parsed.every(isImportAccount) ||
        new Set(parsed.map((item) => item.email)).size !== parsed.length
      ) {
        const error = new Error(t('settings.data.importFailed'));
        Object.assign(error, { diagnostics: { reason: 'invalid_request' } });
        throw error;
      }
      await withAccountsPaused(flow, async () => {
        await loadAccounts(flow);
        const existing = useAccountsStore.getState().accounts;
        const conflict = parsed.filter((item) => existing.some((current) => current.email === item.email)).length;
        if (conflict > 0) {
          setConflictStats({ conflict, new: parsed.length - conflict });
          setPendingAccounts(parsed);
          setImportModalOpen(false);
          setImportPassword('');
          setConflictModalOpen(true);
          flow.log('action', 'transition', { reason: 'state_conflict' });
          return;
        }
        await importAccounts(parsed, false, flow);
        setImportModalOpen(false);
        setImportPassword('');
        setImportFileData('');
        importFlow.current = null;
        flow.log('action', 'success');
        addToast(t('settings.data.importSuccess'), 'success');
      });
    } catch (error) {
      flow.log('action', 'failure', errorDiagnosticDetails(error));
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.importFailed')), 'error');
      importFlow.current = null;
    } finally {
      setDataBusy(false);
      actionGuard.end();
    }
  };

  const handleResolveConflict = async (overwrite: boolean) => {
    if (!actionGuard.begin('settings')) return;
    const flow = (importFlow.current ??= createDiagnosticFlow('settings'));
    flow.log('action', 'start');
    setDataBusy(true);
    try {
      await withAccountsPaused(flow, () => importAccounts(pendingAccounts, overwrite, flow));
      setConflictModalOpen(false);
      setPendingAccounts([]);
      setImportFileData('');
      importFlow.current = null;
      flow.log('action', 'success');
      addToast(t('settings.data.importSuccess'), 'success');
    } catch (error) {
      flow.log('action', 'failure', errorDiagnosticDetails(error));
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.importFailed')), 'error');
    } finally {
      setDataBusy(false);
      actionGuard.end();
    }
  };

  const cancelImport = () => {
    if (dataBusy) return;
    importRead.current++;
    importFlow.current?.log('action', 'cancelled', { reason: 'cancelled' });
    importFlow.current = null;
    setPendingAccounts([]);
    setImportPassword('');
    setImportFileData('');
    setImportModalOpen(false);
    setConflictModalOpen(false);
  };

  const handleClearData = async () => {
    if (!actionGuard.begin('settings')) return;
    const flow = createDiagnosticFlow('settings');
    flow.log('clear_data', 'start');
    let cleared = false;
    try {
      if (!confirm(t('settings.data.confirm'))) {
        flow.log('clear_data', 'cancelled', { reason: 'cancelled' });
        return;
      }
      setDataBusy(true);
      setClearingData(true);
      setClearBlocked(false);
      await withAccountsPaused(flow, async () => {
        const onBlocked = () => setClearBlocked(true);
        await StoreProofClient.clearAll(flow, onBlocked);
        await clearAccounts(flow, onBlocked);
        localStorage.clear();
        clearDiagnosticEvents();
      });
      cleared = true;
      flow.log('clear_data', 'success', { reason: 'cleared' });
      addToast(t('settings.data.cleared'), 'success');
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } catch (error) {
      flow.log('clear_data', 'failure', { reason: 'storage' });
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.clearFailed')), 'error');
    } finally {
      actionGuard.end();
      if (!cleared) {
        setDataBusy(false);
        setClearingData(false);
        setClearBlocked(false);
      }
    }
  };

  const handleExportDiagnostics = () => {
    const events = getDiagnosticEvents();
    const flow = createDiagnosticFlow('settings');
    flow.log('settings', 'start');
    if (!events.length) {
      flow.log('settings', 'blocked', { reason: 'missing_state' });
      addToast(t('settings.diagnostics.empty'), 'info');
      return;
    }
    try {
      const blob = new Blob([JSON.stringify({ schema: 1, events }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'asspp-diagnostics.json';
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      flow.log('settings', 'success');
    } catch (error) {
      flow.log('settings', 'failure', { reason: 'storage' });
      addToast(getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.exportFailed')), 'error');
    }
  };
  return (
    <PageContainer title={t('settings.title')}>
      <div className="min-w-0 space-y-6">
        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.language.title')}</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="language" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('settings.language.label')}
              </label>
              <select
                id="language"
                value={i18n.resolvedLanguage || 'en-US'}
                disabled={dataBusy}
                onChange={async (e) => {
                  const newLang = e.target.value;
                  const flow = createDiagnosticFlow('settings');
                  flow.log('settings', 'start');
                  try {
                    await i18n.changeLanguage(newLang);
                    flow.log('settings', 'success');
                    addToast(t('settings.language.changed'), 'success');
                  } catch (error) {
                    flow.log('settings', 'failure', errorDiagnosticDetails(error));
                    addToast(
                      getErrorMessage(attachDiagnosticId(error, flow.id), t('settings.data.clearFailed')),
                      'error',
                    );
                  }
                }}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              >
                <option value="en-US">English (US)</option>
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="ru">Русский</option>
              </select>
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.defaults.title')}</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="country" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('settings.defaults.country')}
              </label>
              <select
                id="country"
                value={country}
                disabled={dataBusy}
                onChange={(e) => {
                  setCountry(e.target.value);
                  addToast(t('settings.defaults.countryChanged'), 'success');
                }}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              >
                {sortedCountries.map((code) => (
                  <option key={code} value={code}>
                    {t(`countries.${code}`, code)} ({code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="entity" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('settings.defaults.entity')}
              </label>
              <select
                id="entity"
                value={entity}
                disabled={dataBusy}
                onChange={(e) => {
                  setEntity(e.target.value);
                  addToast(t('settings.defaults.entityChanged'), 'success');
                }}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              >
                {entityTypes.map((et) => (
                  <option key={et.value} value={et.value}>
                    {et.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.server.title')}</h2>
          {serverInfo ? (
            <div className="min-w-0 space-y-6">
              <dl className="min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
                {serverInfo.uptime != null && (
                  <SettingsInfoRow label={t('settings.server.uptime')}>
                    {formatUptime(serverInfo.uptime)}
                  </SettingsInfoRow>
                )}
              </dl>

              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                  {t('settings.server.configuration')}
                </h3>
                <dl className="min-w-0 divide-y divide-gray-100 border-y border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                  <SettingsInfoRow label="PORT" mono>
                    {serverInfo.port}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="DATA_DIR" mono valueTitle={serverInfo.dataDir}>
                    {serverInfo.dataDir}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="PUBLIC_BASE_URL" mono valueTitle={serverInfo.publicBaseUrl || undefined}>
                    {serverInfo.publicBaseUrl || (
                      <span className="italic text-gray-400 dark:text-gray-500">{t('settings.server.notSet')}</span>
                    )}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT" mono>
                    {serverInfo.disableHttpsRedirect ? t('settings.server.enabled') : t('settings.server.disabled')}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_DAYS" mono>
                    {serverInfo.autoCleanupDays || t('settings.server.disabled')}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_MAX_MB" mono>
                    {serverInfo.autoCleanupMaxMB || t('settings.server.disabled')}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="MAX_DOWNLOAD_MB" mono>
                    {serverInfo.maxDownloadMB || t('settings.server.disabled')}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="DOWNLOAD_THREADS" mono>
                    {serverInfo.downloadThreads ?? 8}
                  </SettingsInfoRow>
                </dl>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.server.offline')}</p>
          )}
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.data.title')}</h2>
          <p className="mb-4 max-w-full whitespace-nowrap text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-600 dark:text-gray-400">
            {t('settings.data.description')}
          </p>

          <div className="mb-6 grid w-full min-w-0 grid-cols-2 gap-3 sm:max-w-sm">
            <button
              onClick={() => setExportModalOpen(true)}
              disabled={dataBusy}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-blue-300 px-3 py-2 text-center text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 sm:px-4 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              {t('settings.data.exportBtn')}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={dataBusy}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-green-300 px-3 py-2 text-center text-sm font-medium text-green-600 transition-colors hover:bg-green-50 sm:px-4 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/30"
            >
              {t('settings.data.importBtn')}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".enc"
              onChange={handleFileSelect}
              disabled={dataBusy}
            />
          </div>

          <button
            onClick={handleClearData}
            disabled={dataBusy}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-red-300 px-4 py-2 text-center text-sm font-medium text-red-600 transition-colors hover:bg-red-50 sm:w-auto dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
          >
            {clearingData ? t('loading') : t('settings.data.button')}
          </button>
          {clearBlocked && (
            <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">
              {t('settings.data.closeOtherTabs', {
                defaultValue:
                  'Other tabs are still using this data. Close this site in other tabs to finish clearing it.',
              })}
            </p>
          )}
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
            {t('settings.diagnostics.title')}
          </h2>
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{t('settings.diagnostics.description')}</p>
          <button
            onClick={handleExportDiagnostics}
            disabled={dataBusy}
            className="min-h-11 rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/30"
          >
            {t('settings.diagnostics.export')}
          </button>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.about.title')}</h2>
          <p className="max-w-full whitespace-nowrap text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-600 dark:text-gray-400">
            {t('settings.about.description')}
          </p>
          {serverInfo && (
            <dl className="mt-3 min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
              {serverInfo.buildCommit && serverInfo.buildCommit !== 'unknown' && (
                <SettingsInfoRow
                  label={t('settings.about.buildCommit')}
                  mono
                  compact
                  valueTitle={serverInfo.buildCommit}
                >
                  {serverInfo.buildCommit}
                </SettingsInfoRow>
              )}
              {serverInfo.buildDate && serverInfo.buildDate !== 'unknown' && (
                <SettingsInfoRow label={t('settings.about.buildDate')} compact valueTitle={serverInfo.buildDate}>
                  {new Date(serverInfo.buildDate).toLocaleString()}
                </SettingsInfoRow>
              )}
            </dl>
          )}
        </section>
      </div>

      <Modal
        open={exportModalOpen}
        onClose={() => {
          if (!dataBusy) setExportModalOpen(false);
        }}
        title={t('settings.data.exportBtn')}
      >
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('settings.data.passwordPrompt')}
            </label>
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('settings.data.passwordConfirm')}
            </label>
            <input
              type="password"
              value={exportConfirmPassword}
              onChange={(e) => setExportConfirmPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button
            onClick={() => setExportModalOpen(false)}
            disabled={dataBusy}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('settings.data.cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={dataBusy || !exportPassword || !exportConfirmPassword}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
          >
            {t('settings.data.confirmBtn')}
          </button>
        </div>
      </Modal>

      <Modal open={importModalOpen} onClose={cancelImport} title={t('settings.data.importBtn')}>
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('settings.data.passwordPrompt')}
            </label>
            <input
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button
            onClick={cancelImport}
            disabled={dataBusy}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('settings.data.cancel')}
          </button>
          <button
            onClick={handleImport}
            disabled={dataBusy || !importPassword}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
          >
            {t('settings.data.confirmBtn')}
          </button>
        </div>
      </Modal>

      <Modal open={conflictModalOpen} onClose={cancelImport} title={t('settings.data.conflictTitle')}>
        <p className="mb-6 min-w-0 break-words text-sm leading-6 text-gray-700 dark:text-gray-300">
          {t('settings.data.conflictDesc', {
            conflict: conflictStats.conflict,
            new: conflictStats.new,
          })}
        </p>
        <div className="flex min-w-0 flex-col gap-3">
          <button
            onClick={() => handleResolveConflict(true)}
            disabled={dataBusy}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
          >
            {t('settings.data.conflictOverwrite')}
          </button>
          <button
            onClick={() => handleResolveConflict(false)}
            disabled={dataBusy}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('settings.data.conflictSkip')}
          </button>
          <button
            onClick={cancelImport}
            disabled={dataBusy}
            className="mt-2 min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('settings.data.cancel')}
          </button>
        </div>
      </Modal>
    </PageContainer>
  );
}

function SettingsInfoRow({
  label,
  children,
  mono = false,
  compact = false,
  valueTitle,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  compact?: boolean;
  valueTitle?: string;
}) {
  const labelSize = compact ? 'text-xs' : 'text-sm';
  const valueSize = compact ? 'text-xs' : 'text-sm';

  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-start sm:gap-6">
      <dt className={`${labelSize} min-w-0 break-all font-medium text-gray-500 dark:text-gray-400`}>{label}</dt>
      <dd
        title={valueTitle}
        className={`${valueSize} min-w-0 max-w-full whitespace-pre-wrap break-all text-gray-900 sm:text-right dark:text-gray-200 ${
          mono ? 'font-mono' : ''
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
