import i18n from '../i18n';
import { attachDiagnosticId } from './diagnostics';
import type { DiagnosticFlow } from './diagnostics';

const active = new Map<string, Promise<void>>();
const resetLock = 'asspp-account-actions';
let clearing = false;

function blocked(flow: DiagnosticFlow, clearInProgress = false): Error {
  flow.log('lock', 'blocked', { reason: 'busy' });
  const error = new Error(
    i18n.t(clearInProgress ? 'errors.account.clearing' : 'errors.account.busy', {
      defaultValue: clearInProgress
        ? 'Local data is being cleared. Please wait.'
        : 'Another action for this account is in progress. Please wait and try again.',
    }),
  );
  Object.assign(error, { diagnostics: { reason: 'busy' } });
  return attachDiagnosticId(error, flow.id);
}

/** Keep account cookies, tokens and state writes in one operation across views/tabs. */
export async function withAccountAction<T>(email: string, flow: DiagnosticFlow, action: () => Promise<T>): Promise<T> {
  const key = email.trim().toLowerCase();
  if (clearing || active.has(key)) throw blocked(flow, clearing);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => (release = resolve));
  active.set(key, finished);
  flow.log('lock', 'start', { reason: 'lock_wait' });
  const run = async () => {
    flow.log('lock', 'success', { reason: 'lock_acquired' });
    return action();
  };
  try {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(resetLock, { mode: 'shared', ifAvailable: true }, async (globalLock) => {
        if (!globalLock) throw blocked(flow, true);
        return navigator.locks.request(`${resetLock}:${key}`, { ifAvailable: true }, async (accountLock) => {
          if (!accountLock) throw blocked(flow);
          return run();
        });
      });
    }
    return await run();
  } finally {
    if (active.get(key) === finished) active.delete(key);
    release();
  }
}

/** Block new actions and drain existing work before importing or deleting state. */
export async function withAccountsPaused<T>(flow: DiagnosticFlow, action: () => Promise<T>): Promise<T> {
  if (clearing) throw blocked(flow, true);
  clearing = true;
  flow.log('lock', 'start', { reason: 'lock_wait' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    await Promise.race([
      Promise.allSettled([...active.values()]),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Lock wait timed out', 'TimeoutError')),
          { once: true },
        ),
      ),
    ]);
    const run = async () => {
      flow.log('lock', 'success', { reason: 'lock_acquired' });
      return action();
    };
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(resetLock, { mode: 'exclusive', signal: controller.signal }, run);
    }
    return await run();
  } catch (error) {
    flow.log('lock', 'failure', { reason: controller.signal.aborted ? 'lock_timeout' : 'unknown' });
    throw attachDiagnosticId(error, flow.id);
  } finally {
    clearTimeout(timeout);
    clearing = false;
  }
}

export function missingAccount(flow: DiagnosticFlow): Error {
  const error = new Error(
    i18n.t('errors.account.missing', {
      defaultValue: 'This account no longer exists. Add it again before continuing.',
    }),
  );
  Object.assign(error, { diagnostics: { reason: 'not_found' } });
  return attachDiagnosticId(error, flow.id);
}
