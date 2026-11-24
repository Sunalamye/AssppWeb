import { create } from 'zustand';
import * as downloadsApi from '../api/downloads';
import { attachDiagnosticId, createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { StartDownloadInput } from '../api/downloads';
import type { DownloadTask } from '../types';

interface DownloadsState {
  tasks: DownloadTask[];
  loading: boolean;
  accountHashes: string[];
  setAccountHashes: (hashes: string[]) => void;
  fetchTasks: (flow?: DiagnosticFlow) => Promise<void>;
  startDownload: (data: StartDownloadInput, flow?: DiagnosticFlow) => Promise<void>;
  pauseDownload: (id: string, flow?: DiagnosticFlow) => Promise<void>;
  resumeDownload: (id: string, flow?: DiagnosticFlow) => Promise<void>;
  deleteDownload: (id: string, flow?: DiagnosticFlow) => Promise<void>;
}

type TaskAction = 'pause' | 'resume' | 'delete';
const actionStages = { pause: 'task_pause', resume: 'task_resume', delete: 'task_cancel' } as const;
type MutationStage = (typeof actionStages)[TaskAction] | 'download_enqueue';

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let scope = 0;
  let revision = 0;
  let listRequest: { revision: number; promise: Promise<void> } | undefined;
  const mutations = new Map<string, { stage: MutationStage; promise: Promise<void> }>();

  function stopPolling(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePolling(): void {
    stopPolling();
    if (mutations.size || !get().accountHashes.length) return;
    if (!get().tasks.some((task) => ['downloading', 'pending', 'injecting'].includes(task.status))) return;
    // Schedule after a response settles, so slow requests cannot overlap polls.
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void get()
        .fetchTasks()
        .catch(() => {
          // fetchTasks already recorded the safe failure. Keep timer rejections handled.
        });
    }, 2000);
  }

  function invalidateList(): void {
    revision++;
    stopPolling();
    set({ loading: false });
  }

  function blocked(flow: DiagnosticFlow, stage: MutationStage, reason: 'busy' | 'not_found'): Error {
    flow.log(stage, 'blocked', { endpoint: 'backend_downloads', reason });
    const error = new Error(
      reason === 'busy' ? 'Another action for this download is in progress.' : 'This download is no longer available.',
    );
    Object.assign(error, { diagnostics: { reason } });
    return attachDiagnosticId(error, flow.id);
  }

  function runMutation(
    key: string,
    stage: MutationStage,
    flow: DiagnosticFlow,
    action: () => Promise<void>,
  ): Promise<void> {
    const pending = mutations.get(key);
    if (pending) {
      if (pending.stage !== stage) return Promise.reject(blocked(flow, stage, 'busy'));
      flow.log(stage, 'blocked', { endpoint: 'backend_downloads', reason: 'busy' });
      return pending.promise;
    }
    const started = Date.now();
    invalidateList();
    flow.log(stage, 'start', { endpoint: 'backend_downloads' });
    const promise = (async () => {
      try {
        await action();
        flow.log(stage, 'success', { endpoint: 'backend_downloads', durationMs: Date.now() - started });
      } catch (error) {
        flow.log(stage, 'failure', {
          ...errorDiagnosticDetails(error),
          endpoint: 'backend_downloads',
          durationMs: Date.now() - started,
        });
        throw attachDiagnosticId(error, flow.id);
      } finally {
        mutations.delete(key);
        schedulePolling();
      }
    })();
    mutations.set(key, { stage, promise });
    return promise;
  }

  async function refreshAfterMutation(flow: DiagnosticFlow): Promise<void> {
    try {
      await get().fetchTasks(flow);
    } catch {
      // The list failure is logged separately; the successful mutation must not be replayed.
    }
  }

  function changeTask(action: TaskAction, id: string, flow: DiagnosticFlow): Promise<void> {
    const stage = actionStages[action];
    const task = get().tasks.find((entry) => entry.id === id);
    if (!task) return Promise.reject(blocked(flow, stage, 'not_found'));
    const startedScope = scope;
    return runMutation(`${task.accountHash}:${id}`, stage, flow, async () => {
      if (action === 'pause') await downloadsApi.pauseDownload(id, task.accountHash, flow);
      else if (action === 'resume') await downloadsApi.resumeDownload(id, task.accountHash, flow);
      else await downloadsApi.deleteDownload(id, task.accountHash, flow);
      if (scope !== startedScope) return;
      invalidateList();
      set({
        tasks:
          action === 'delete'
            ? get().tasks.filter((entry) => entry.id !== id)
            : get().tasks.map((entry) =>
                entry.id === id ? { ...entry, status: action === 'pause' ? 'paused' : 'pending' } : entry,
              ),
      });
      await refreshAfterMutation(flow);
    });
  }

  return {
    tasks: [],
    loading: false,
    accountHashes: [],

    setAccountHashes: (hashes) => {
      const normalized = [...new Set(hashes)].sort();
      if (normalized.join(',') === get().accountHashes.join(',')) return;
      scope++;
      invalidateList();
      set({ accountHashes: normalized, tasks: [], loading: false });
    },

    fetchTasks: (flow = createDiagnosticFlow('download')) => {
      const requestedRevision = revision;
      if (listRequest) {
        if (listRequest.revision === requestedRevision) return listRequest.promise;
        // A new scope waits for the bounded old request, then issues just one fresh read.
        set({ loading: true });
        return listRequest.promise
          .catch(() => undefined)
          .then(() => {
            if (requestedRevision !== revision) {
              flow.log('task_state', 'cancelled', { reason: 'state_conflict' });
              return;
            }
            return get().fetchTasks(flow);
          });
      }
      const hashes = [...get().accountHashes];
      const started = Date.now();
      stopPolling();
      set({ loading: true });
      flow.log('task_state', 'start', { endpoint: 'backend_downloads' });
      const promise = (async () => {
        try {
          const tasks = await downloadsApi.fetchDownloads(hashes, flow);
          if (requestedRevision !== revision) {
            flow.log('task_state', 'cancelled', { reason: 'state_conflict' });
            return;
          }
          set({ tasks });
          flow.log('task_state', 'success', { endpoint: 'backend_downloads', durationMs: Date.now() - started });
        } catch (error) {
          if (requestedRevision !== revision) {
            flow.log('task_state', 'cancelled', { reason: 'state_conflict' });
            return;
          }
          flow.log('task_state', 'failure', {
            ...errorDiagnosticDetails(error),
            endpoint: 'backend_downloads',
            durationMs: Date.now() - started,
          });
          throw attachDiagnosticId(error, flow.id);
        } finally {
          listRequest = undefined;
          if (requestedRevision === revision) {
            set({ loading: false });
            schedulePolling();
          }
        }
      })();
      listRequest = { revision: requestedRevision, promise };
      return promise;
    },

    startDownload: (data, flow = createDiagnosticFlow('download')) => {
      const startedScope = scope;
      const key = `new:${data.accountHash}:${data.software.id}:${data.software.version}`;
      return runMutation(key, 'download_enqueue', flow, async () => {
        const task = await downloadsApi.startDownload(data, flow);
        if (scope !== startedScope) return;
        invalidateList();
        if (get().accountHashes.includes(task.accountHash)) {
          set({ tasks: [task, ...get().tasks.filter((entry) => entry.id !== task.id)] });
        }
        await refreshAfterMutation(flow);
      });
    },

    pauseDownload: (id, flow = createDiagnosticFlow('download')) => changeTask('pause', id, flow),
    resumeDownload: (id, flow = createDiagnosticFlow('download')) => changeTask('resume', id, flow),
    deleteDownload: (id, flow = createDiagnosticFlow('download')) => changeTask('delete', id, flow),
  };
});
