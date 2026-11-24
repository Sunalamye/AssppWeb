import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadsStore } from '../../src/store/downloads';
import * as downloadsApi from '../../src/api/downloads';
import { clearDiagnosticEvents, createDiagnosticFlow, getDiagnosticEvents } from '../../src/utils/diagnostics';
import type { DownloadTask, Software } from '../../src/types';

vi.mock('../../src/api/downloads', () => ({
  fetchDownloads: vi.fn(),
  startDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function task(
  id = 'private-task',
  status: DownloadTask['status'] = 'downloading',
  accountHash = 'private-hash',
): DownloadTask {
  return {
    id,
    accountHash,
    software: { id: 123, name: 'private-app', version: '1.0' } as Software,
    status,
    progress: 0,
    speed: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  useDownloadsStore.getState().setAccountHashes([]);
  useDownloadsStore.getState().setAccountHashes(['private-hash']);
  clearDiagnosticEvents();
  vi.mocked(downloadsApi.fetchDownloads).mockResolvedValue([]);
  vi.mocked(downloadsApi.pauseDownload).mockResolvedValue(undefined);
  vi.mocked(downloadsApi.resumeDownload).mockResolvedValue(undefined);
  vi.mocked(downloadsApi.deleteDownload).mockResolvedValue(undefined);
  vi.mocked(downloadsApi.startDownload).mockResolvedValue(task('new-task', 'pending'));
});

afterEach(() => {
  useDownloadsStore.getState().setAccountHashes([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('download store request ordering', () => {
  it('shares an active list request and schedules the next poll after it settles', async () => {
    const pending = deferred<DownloadTask[]>();
    vi.mocked(downloadsApi.fetchDownloads).mockReturnValueOnce(pending.promise);
    const first = useDownloadsStore.getState().fetchTasks();
    const duplicate = useDownloadsStore.getState().fetchTasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(1);
    pending.resolve([task()]);
    await Promise.all([first, duplicate]);
    const slowPoll = deferred<DownloadTask[]>();
    vi.mocked(downloadsApi.fetchDownloads).mockReturnValueOnce(slowPoll.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(2);
    slowPoll.resolve([task('private-task', 'completed')]);
    await useDownloadsStore.getState().fetchTasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(2);
  });

  it('clears the previous account immediately and never applies its late response', async () => {
    useDownloadsStore.setState({ tasks: [task()] });
    const old = deferred<DownloadTask[]>();
    vi.mocked(downloadsApi.fetchDownloads).mockReturnValueOnce(old.promise);
    const first = useDownloadsStore.getState().fetchTasks();
    useDownloadsStore.getState().setAccountHashes(['other-hash']);
    expect(useDownloadsStore.getState().tasks).toEqual([]);
    const fresh = task('other-task', 'completed', 'other-hash');
    vi.mocked(downloadsApi.fetchDownloads).mockResolvedValueOnce([fresh]);
    const replacement = useDownloadsStore.getState().fetchTasks();
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(1);
    old.resolve([task()]);
    await Promise.all([first, replacement]);
    expect(useDownloadsStore.getState().tasks).toEqual([fresh]);
    expect(downloadsApi.fetchDownloads).toHaveBeenLastCalledWith(['other-hash'], expect.any(Object));
    expect(useDownloadsStore.getState().loading).toBe(false);
  });

  it('stops polling when all accounts are removed and discards a late active list', async () => {
    const old = deferred<DownloadTask[]>();
    vi.mocked(downloadsApi.fetchDownloads).mockReturnValueOnce(old.promise);
    const request = useDownloadsStore.getState().fetchTasks();
    useDownloadsStore.getState().setAccountHashes([]);
    old.resolve([task()]);
    await request;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useDownloadsStore.getState().tasks).toEqual([]);
    expect(useDownloadsStore.getState().loading).toBe(false);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(1);
  });

  it('does not restore a deleted task when an older poll finishes', async () => {
    useDownloadsStore.setState({ tasks: [task()] });
    const old = deferred<DownloadTask[]>();
    vi.mocked(downloadsApi.fetchDownloads).mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const poll = useDownloadsStore.getState().fetchTasks();
    const removed = useDownloadsStore.getState().deleteDownload('private-task');
    await Promise.resolve();
    expect(useDownloadsStore.getState().tasks).toEqual([]);
    old.resolve([task()]);
    await Promise.all([poll, removed]);
    expect(useDownloadsStore.getState().tasks).toEqual([]);
    expect(downloadsApi.deleteDownload).toHaveBeenCalledTimes(1);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(2);
  });

  it('keeps account changes isolated from a mutation that finishes late', async () => {
    useDownloadsStore.setState({ tasks: [task()] });
    const pending = deferred<void>();
    vi.mocked(downloadsApi.pauseDownload).mockReturnValueOnce(pending.promise);
    const paused = useDownloadsStore.getState().pauseDownload('private-task');
    useDownloadsStore.getState().setAccountHashes(['other-hash']);
    const fresh = task('other-task', 'completed', 'other-hash');
    vi.mocked(downloadsApi.fetchDownloads).mockResolvedValueOnce([fresh]);
    await useDownloadsStore.getState().fetchTasks();
    pending.resolve(undefined);
    await paused;
    expect(useDownloadsStore.getState().tasks).toEqual([fresh]);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(1);
  });
});

describe('download mutation locks and diagnostics', () => {
  it('coalesces repeated actions for one task and rejects conflicting actions', async () => {
    useDownloadsStore.setState({ tasks: [task()] });
    const pending = deferred<void>();
    vi.mocked(downloadsApi.pauseDownload).mockReturnValueOnce(pending.promise);
    const first = useDownloadsStore.getState().pauseDownload('private-task');
    const duplicate = useDownloadsStore.getState().pauseDownload('private-task');
    await expect(useDownloadsStore.getState().resumeDownload('private-task')).rejects.toMatchObject({
      diagnostics: { reason: 'busy' },
    });
    expect(downloadsApi.pauseDownload).toHaveBeenCalledTimes(1);
    expect(downloadsApi.resumeDownload).not.toHaveBeenCalled();
    pending.resolve(undefined);
    await Promise.all([first, duplicate]);
  });

  it('allows different tasks to change concurrently', async () => {
    useDownloadsStore.setState({ tasks: [task('first'), task('second')] });
    const first = deferred<void>();
    const second = deferred<void>();
    vi.mocked(downloadsApi.pauseDownload).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstAction = useDownloadsStore.getState().pauseDownload('first');
    const secondAction = useDownloadsStore.getState().pauseDownload('second');
    expect(downloadsApi.pauseDownload).toHaveBeenCalledTimes(2);
    first.resolve(undefined);
    second.resolve(undefined);
    await Promise.all([firstAction, secondAction]);
  });

  it('surfaces failures, releases the task lock, and keeps raw errors out of diagnostics', async () => {
    useDownloadsStore.setState({ tasks: [task()] });
    const flow = createDiagnosticFlow('download');
    const error = Object.assign(new Error('private-token-in-server-body'), {
      diagnostics: { httpStatus: 503, reason: 'http_error' },
    });
    vi.mocked(downloadsApi.pauseDownload).mockRejectedValueOnce(error);
    await expect(useDownloadsStore.getState().pauseDownload('private-task', flow)).rejects.toMatchObject({
      diagnosticId: flow.id,
    });
    expect(useDownloadsStore.getState().tasks[0].status).toBe('downloading');
    await useDownloadsStore.getState().pauseDownload('private-task');
    expect(downloadsApi.pauseDownload).toHaveBeenCalledTimes(2);
    const events = getDiagnosticEvents().filter((event) => event.flowId === flow.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'task_pause', outcome: 'start' }),
        expect.objectContaining({ stage: 'task_pause', outcome: 'failure', reason: 'http_error', httpStatus: 503 }),
      ]),
    );
    expect(JSON.stringify(events)).not.toMatch(/private-token|private-task|private-hash|private-app/);
  });

  it('handles polling failures, records them safely, and retries without an unhandled rejection', async () => {
    vi.mocked(downloadsApi.fetchDownloads)
      .mockResolvedValueOnce([task()])
      .mockRejectedValueOnce(new Error('private-list-response'))
      .mockResolvedValueOnce([task('private-task', 'completed')]);
    await useDownloadsStore.getState().fetchTasks();
    await vi.advanceTimersByTimeAsync(4000);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledTimes(3);
    expect(useDownloadsStore.getState().tasks[0].status).toBe('completed');
    const events = getDiagnosticEvents();
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'task_state', outcome: 'failure' })]),
    );
    expect(JSON.stringify(events)).not.toContain('private-list-response');
  });

  it('does not re-enqueue after a successful creation if the list refresh fails', async () => {
    const flow = createDiagnosticFlow('download');
    const created = deferred<DownloadTask>();
    vi.mocked(downloadsApi.startDownload).mockReturnValueOnce(created.promise);
    vi.mocked(downloadsApi.fetchDownloads).mockRejectedValueOnce(new Error('private-refresh-error'));
    const input = {
      software: task().software,
      accountHash: 'private-hash',
      downloadURL: 'https://private-url',
      sinfs: [],
    };
    const first = useDownloadsStore.getState().startDownload(input, flow);
    const duplicate = useDownloadsStore.getState().startDownload(input);
    created.resolve(task('new-task', 'pending'));
    await Promise.all([first, duplicate]);
    expect(downloadsApi.startDownload).toHaveBeenCalledTimes(1);
    expect(downloadsApi.startDownload).toHaveBeenCalledWith(input, flow);
    expect(downloadsApi.fetchDownloads).toHaveBeenCalledWith(['private-hash'], flow);
    expect(useDownloadsStore.getState().tasks[0].id).toBe('new-task');
    const events = getDiagnosticEvents().filter((event) => event.flowId === flow.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'download_enqueue', outcome: 'success' }),
        expect.objectContaining({ stage: 'task_state', outcome: 'failure' }),
      ]),
    );
    expect(JSON.stringify(events)).not.toMatch(/private-refresh-error|private-url|private-hash/);
  });
});
