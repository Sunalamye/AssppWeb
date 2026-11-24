import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config, DOWNLOAD_TIMEOUT_MS } from '../config.js';
import { inject } from './sinfInjector.js';
import { ChunkedDownloader } from './chunkedDownloader.js';
import { createServerDiagnostic } from '../utils/diagnostics.js';
import { transitionDownload } from '../domain/downloadPolicy.js';
import type { DownloadEvent } from '../domain/downloadPolicy.js';
import type { DiagnosticEvent, DiagnosticDetails, ServerDiagnostic } from '../utils/diagnostics.js';
import type { DownloadTask, Software, Sinf } from '../types/index.js';

const tasks = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const chunkDownloaders = new Map<string, ChunkedDownloader>();
const progressListeners = new Map<string, Set<(task: DownloadTask) => void>>();
const activeRuns = new Map<string, symbol>();
const runningJobs = new Map<string, Promise<void>>();
const taskDiagnostics = new Map<string, ServerDiagnostic>();

function taskTrace(task: DownloadTask): ServerDiagnostic {
  let trace = taskDiagnostics.get(task.id);
  if (!trace) {
    trace = createServerDiagnostic('download');
    taskDiagnostics.set(task.id, trace);
  }
  return trace;
}

function setTaskState(
  task: DownloadTask,
  event: DownloadEvent,
  reason?: DiagnosticDetails['reason'],
  currentGeneration = true,
): boolean {
  const state = transitionDownload(task.status, event, currentGeneration);
  if (state === task.status) return false;
  if (state === 'deleted') tasks.delete(task.id);
  else task.status = state;
  taskTrace(task).event(
    'task_state',
    state === 'completed' ? 'success' : state === 'failed' ? 'failure' : 'transition',
    reason ? { reason } : {},
    { taskId: task.id, taskState: state },
  );
  return true;
}

const PACKAGES_DIR = path.join(config.dataDir, 'packages');
const TASKS_FILE = path.join(config.dataDir, 'tasks.json');
// Legacy file from old code — cleaned up on startup
const LEGACY_DOWNLOADS_FILE = path.join(config.dataDir, 'downloads.json');

// --- Security: path segment validation ---
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Validate and sanitize a path segment. Rejects traversal, replaces unsafe chars. */
function safePathSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`);
  }
  if (SAFE_SEGMENT_RE.test(value)) return value;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid ${label}`);
  }
  return cleaned;
}

// --- Security: download URL allowlist ---
const ALLOWED_DOWNLOAD_HOSTS_RE = /\.apple\.com$/i;

export function validateDownloadURL(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid download URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Download URL must use HTTPS');
  }

  if (!ALLOWED_DOWNLOAD_HOSTS_RE.test(parsed.hostname)) {
    throw new Error('Download URL must be from an Apple domain (*.apple.com)');
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname.startsWith('[')) {
    throw new Error('Download URL must not use IP addresses');
  }
}

// --- Security: sanitize task for API responses ---
export function sanitizeTaskForResponse(
  task: DownloadTask,
): Omit<DownloadTask, 'downloadURL' | 'sinfs' | 'iTunesMetadata' | 'filePath'> & { hasFile?: boolean } {
  const { downloadURL, sinfs, iTunesMetadata, filePath, ...safe } = task;
  return {
    ...safe,
    hasFile: !!filePath && fs.existsSync(filePath),
  };
}

// --- Persistence: save only completed task metadata (no secrets) ---
function persistTasks(completing?: DownloadTask) {
  const completed = Array.from(tasks.values())
    .filter((t) => (t.status === 'completed' || t === completing) && t.filePath)
    .map((t) => ({
      id: t.id,
      software: t.software,
      accountHash: t.accountHash,
      downloadURL: '',
      sinfs: [],
      status: 'completed',
      progress: 100,
      speed: '0 B/s',
      filePath: t.filePath,
      createdAt: t.createdAt,
    }));
  // Publish a complete replacement on the same filesystem. A failed write or
  // rename must leave the previous index usable on the next process start.
  const temporary = `${TASKS_FILE}.${uuidv4()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(completed, null, 2), { mode: 0o600, flush: true });
    fs.renameSync(temporary, TASKS_FILE);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed successfully or cleanup is unavailable. */
    }
  }
}

function deleteCleanupTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  const trace = taskTrace(task);
  try {
    return deleteTask(id);
  } catch {
    // One inaccessible package must not stop cleanup or an unrelated download.
    trace.event('package_save', 'failure', { reason: 'storage' }, { taskId: id });
    // Deleting the file may have succeeded before the index publication failed.
    // Count those freed bytes so a metadata error does not evict extra packages.
    return !tasks.has(id);
  }
}

// Auto-cleanup: delete completed files older than configured days
export function runTimeCleanup() {
  const { autoCleanupDays } = config;
  if (autoCleanupDays <= 0) return;
  const cutoff = Date.now() - autoCleanupDays * 24 * 60 * 60 * 1000;

  // Collect IDs first to avoid mutating the map during iteration
  const expiredIds: string[] = [];
  for (const task of tasks.values()) {
    if (task.status === 'completed' && task.filePath && fs.existsSync(task.filePath)) {
      try {
        const stat = fs.statSync(task.filePath);
        if (stat.mtimeMs < cutoff) {
          expiredIds.push(task.id);
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }

  for (const id of expiredIds) {
    deleteCleanupTask(id);
  }
}

// Auto-cleanup: evict oldest completed files when total size exceeds limit
export function runSpaceCleanup() {
  const { autoCleanupMaxMB } = config;
  if (autoCleanupMaxMB <= 0) return;
  const maxBytes = autoCleanupMaxMB * 1024 * 1024;

  let totalBytes = 0;
  const fileTasks: { id: string; size: number; mtimeMs: number }[] = [];

  for (const task of tasks.values()) {
    if (task.status === 'completed' && task.filePath && fs.existsSync(task.filePath)) {
      try {
        const stat = fs.statSync(task.filePath);
        totalBytes += stat.size;
        fileTasks.push({ id: task.id, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // File inaccessible — skip
      }
    }
  }

  if (totalBytes <= maxBytes) return;

  fileTasks.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const ft of fileTasks) {
    if (deleteCleanupTask(ft.id)) totalBytes -= ft.size;
    if (totalBytes <= maxBytes) break;
  }
}

// Schedule daily time-based cleanup at midnight (self-correcting to avoid drift)
function scheduleDailyCleanup() {
  function msUntilMidnight(): number {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  function tick() {
    try {
      runTimeCleanup();
    } finally {
      setTimeout(tick, msUntilMidnight());
    }
  }

  setTimeout(tick, msUntilMidnight());
}

function initOnStartup() {
  // Remove legacy downloads.json from old code
  if (fs.existsSync(LEGACY_DOWNLOADS_FILE)) {
    fs.unlinkSync(LEGACY_DOWNLOADS_FILE);
  }

  // Ensure packages dir exists
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });

  // Missing or corrupt metadata is not evidence that existing final packages
  // are disposable; restore a task only from a fully readable index.
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
      if (!Array.isArray(data)) throw new Error('Invalid task index');
      const packagesBase = path.resolve(PACKAGES_DIR) + path.sep;
      if (
        !data.every(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            item.id.length > 0 &&
            item.status === 'completed' &&
            typeof item.accountHash === 'string' &&
            typeof item.createdAt === 'string' &&
            typeof item.filePath === 'string' &&
            path.resolve(item.filePath).startsWith(packagesBase) &&
            item.software &&
            typeof item.software.name === 'string' &&
            typeof item.software.bundleID === 'string' &&
            typeof item.software.version === 'string',
        )
      ) {
        throw new Error('Invalid task index');
      }
      for (const item of data) {
        // Only restore completed tasks whose IPA file still exists
        if (item.id && item.status === 'completed' && item.filePath && fs.existsSync(item.filePath)) {
          const task: DownloadTask = {
            id: item.id,
            software: item.software,
            accountHash: item.accountHash,
            downloadURL: '',
            sinfs: [],
            status: 'completed',
            progress: 100,
            speed: '0 B/s',
            filePath: item.filePath,
            createdAt: item.createdAt,
          };
          tasks.set(task.id, task);
        }
      }
    } catch {
      createServerDiagnostic('download').event('package_save', 'failure', { reason: 'storage' });
    }
  }

  // Clean up recognized transient parts only. An unindexed final IPA may be a
  // completed package whose metadata was lost; keep it for manual recovery,
  // including after a subsequent successful index write and process restart.
  cleanTransientParts();

  // Run time-based cleanup once on startup, then schedule daily
  runTimeCleanup();
  scheduleDailyCleanup();
}

function cleanTransientParts() {
  const knownPaths = new Set<string>();
  for (const task of tasks.values()) {
    if (task.filePath) {
      knownPaths.add(path.resolve(task.filePath));
    }
  }

  const packagesBase = path.resolve(PACKAGES_DIR);

  function walkAndClean(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndClean(fullPath);
        // Remove empty directories
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      } else if (entry.isFile() && /\.ipa\.part[0-9]+$/.test(entry.name) && !knownPaths.has(path.resolve(fullPath))) {
        // Only known downloader scratch files are disposable without metadata.
        fs.unlinkSync(fullPath);
      }
    }
  }

  walkAndClean(packagesBase);
}

// Initialize on startup
initOnStartup();

function notifyProgress(task: DownloadTask) {
  const listeners = progressListeners.get(task.id);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener(task);
      } catch {
        // A disconnected progress observer cannot fail the download itself.
        listeners.delete(listener);
      }
    }
  }
}

export function addProgressListener(taskId: string, listener: (task: DownloadTask) => void) {
  let listeners = progressListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    progressListeners.set(taskId, listeners);
  }
  listeners.add(listener);
}

export function removeProgressListener(taskId: string, listener: (task: DownloadTask) => void) {
  const listeners = progressListeners.get(taskId);
  if (listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) {
      progressListeners.delete(taskId);
    }
  }
}

export function getAllTasks(): DownloadTask[] {
  return Array.from(tasks.values());
}

export function getTask(id: string): DownloadTask | undefined {
  return tasks.get(id);
}

export function deleteTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  const trace = taskTrace(task);
  trace.event('task_cancel', 'start', {}, { taskId: task.id });
  activeRuns.delete(id);

  // Abort if downloading
  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  try {
    // Remove file if exists, with path safety check
    if (task.filePath) {
      const resolved = path.resolve(task.filePath);
      const packagesBase = path.resolve(PACKAGES_DIR);
      if (resolved.startsWith(packagesBase + path.sep) && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);

        // Clean up empty parent directories
        let dir = path.dirname(resolved);
        while (dir !== packagesBase && dir.startsWith(packagesBase)) {
          const contents = fs.readdirSync(dir);
          if (contents.length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      }
    }
  } catch {
    // The old run is already invalidated. Keep a terminal, retryable task rather
    // than a downloading/injecting task with no worker after a filesystem error.
    task.error = 'Failed to delete download';
    task.speed = '0 B/s';
    setTaskState(task, 'deleteFailed', 'storage');
    trace.event('task_cancel', 'failure', { reason: 'storage' }, { taskId: task.id, taskState: 'failed' });
    try {
      // Remove previously completed metadata when storage is still writable.
      persistTasks();
    } catch {
      trace.event('package_save', 'failure', { reason: 'storage' }, { taskId: task.id, taskState: 'failed' });
    }
    notifyProgress(task);
    throw new Error('Failed to delete download');
  }

  setTaskState(task, 'delete', 'cancelled');
  progressListeners.delete(id);
  taskDiagnostics.delete(id);
  try {
    persistTasks();
  } catch {
    trace.event('package_save', 'failure', { reason: 'storage' }, { taskId: id, taskState: 'deleted' });
    trace.event('task_cancel', 'failure', { reason: 'storage' }, { taskId: id, taskState: 'deleted' });
    throw new Error('Failed to save download deletion');
  }
  trace.event('task_cancel', 'cancelled', { reason: 'cancelled' }, { taskId: task.id, taskState: 'deleted' });
  return true;
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || transitionDownload(task.status, 'pause', true) === task.status) return false;
  // Invalidate before abort: an old rejection must never mutate a resumed run.
  activeRuns.delete(id);

  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  setTaskState(task, 'pause', 'cancelled');
  task.speed = '0 B/s';
  taskTrace(task).event('task_pause', 'success', {}, { taskId: task.id, taskState: 'paused' });
  notifyProgress(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || transitionDownload(task.status, 'resume', true) === task.status) return false;
  taskTrace(task).event('task_resume', 'start', {}, { taskId: task.id });
  startDownload(task);
  return true;
}

export function createTask(
  software: Software,
  accountHash: string,
  downloadURL: string,
  sinfs: Sinf[],
  iTunesMetadata?: string,
  diagnostics?: ServerDiagnostic,
): DownloadTask {
  // Validate download URL
  validateDownloadURL(downloadURL);

  // Validate path segments
  safePathSegment(accountHash, 'accountHash');
  safePathSegment(software.bundleID, 'bundleID');
  safePathSegment(software.version, 'version');

  const task: DownloadTask = {
    id: uuidv4(),
    software,
    accountHash,
    downloadURL,
    sinfs,
    iTunesMetadata,
    status: 'pending',
    progress: 0,
    speed: '0 B/s',
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  taskDiagnostics.set(task.id, diagnostics ?? createServerDiagnostic('download'));
  taskTrace(task).event('task_state', 'transition', {}, { taskId: task.id, taskState: 'pending' });
  startDownload(task);
  return task;
}

function startDownload(task: DownloadTask) {
  const run = Symbol('download-run');
  const previous = runningJobs.get(task.id);
  activeRuns.set(task.id, run);
  // Resume becomes pending immediately, so a second resume cannot enqueue a
  // second job while the aborted predecessor is still releasing file handles.
  if (task.status !== 'pending') setTaskState(task, 'resume');
  notifyProgress(task);
  const job = (async () => {
    if (previous) await previous;
    if (tasks.get(task.id) !== task || activeRuns.get(task.id) !== run) return;
    await runDownload(task, run);
  })();
  runningJobs.set(task.id, job);
  void job.finally(() => {
    if (runningJobs.get(task.id) === job) runningJobs.delete(task.id);
  });
}

async function runDownload(task: DownloadTask, run: symbol) {
  const current = () => tasks.get(task.id) === task && activeRuns.get(task.id) === run;
  const trace = taskTrace(task);
  const controller = new AbortController();
  let downloader: ChunkedDownloader | undefined;
  let timedOut = false;
  let filePath: string | undefined;
  let stage: DiagnosticEvent['stage'] = 'package_save';
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOWNLOAD_TIMEOUT_MS);
  abortControllers.set(task.id, controller);
  try {
    runTimeCleanup();
    runSpaceCleanup();
    if (!current()) return;
    if (!setTaskState(task, 'start', undefined, current())) return;
    task.progress = 0;
    task.speed = '0 B/s';
    task.error = undefined;
    notifyProgress(task);

    const safeAccountHash = safePathSegment(task.accountHash, 'accountHash');
    const safeBundleID = safePathSegment(task.software.bundleID, 'bundleID');
    const safeVersion = safePathSegment(task.software.version, 'version');
    const dir = path.join(PACKAGES_DIR, safeAccountHash, safeBundleID, safeVersion);
    if (!path.resolve(dir).startsWith(path.resolve(PACKAGES_DIR) + path.sep)) throw new Error('Invalid path');
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, `${task.id}.ipa`);
    task.filePath = filePath;
    validateDownloadURL(task.downloadURL);

    stage = 'download_fetch';
    trace.event(stage, 'start', { endpoint: 'backend_downloads' }, { taskId: task.id });
    downloader = new ChunkedDownloader(task.downloadURL, filePath, {
      onDiagnostic: (outcome, details) => {
        if (current()) trace.event('download_fetch', outcome, details, { taskId: task.id });
      },
      onProgress: (info) => {
        if (!current() || controller.signal.aborted) return;
        task.speed = info.speed;
        if (info.total > 0) task.progress = Math.round((info.downloaded / info.total) * 100);
        notifyProgress(task);
      },
    });
    chunkDownloaders.set(task.id, downloader);
    await downloader.download(controller.signal);
    if (!current() || controller.signal.aborted) {
      if (current() && timedOut) throw new DOMException('Timed out', 'AbortError');
      trace.event(stage, 'cancelled', { reason: 'cancelled' }, { taskId: task.id });
      return;
    }
    trace.event(stage, 'success', {}, { taskId: task.id });

    if (task.sinfs.length > 0 || task.iTunesMetadata) {
      stage = 'ipa_compile';
      if (!setTaskState(task, 'compile', undefined, current())) return;
      task.progress = 100;
      notifyProgress(task);
      trace.event(stage, 'start', {}, { taskId: task.id });
      await inject(task.sinfs, filePath, task.iTunesMetadata);
      if (!current() || controller.signal.aborted) {
        if (current() && timedOut) throw new DOMException('Timed out', 'AbortError');
        trace.event(stage, 'cancelled', { reason: 'cancelled' }, { taskId: task.id });
        return;
      }
      trace.event(stage, 'success', {}, { taskId: task.id });
    }

    stage = 'package_save';
    trace.event(stage, 'start', {}, { taskId: task.id });
    // Persist the proposed completed record before reporting completion or
    // discarding the inputs needed to describe this still-active run.
    persistTasks(task);
    setTaskState(task, 'complete', undefined, current());
    task.progress = 100;
    task.speed = '0 B/s';
    task.downloadURL = '';
    task.sinfs = [];
    task.iTunesMetadata = undefined;
    trace.event(stage, 'success', {}, { taskId: task.id });
    notifyProgress(task);
  } catch {
    if (!current()) {
      trace.event(stage, 'cancelled', { reason: 'cancelled' }, { taskId: task.id });
      return;
    }
    const reason = timedOut ? 'timeout' : stage === 'package_save' ? 'storage' : 'network';
    trace.event(stage, 'failure', { reason }, { taskId: task.id });
    setTaskState(task, 'fail', reason, current());
    task.error = timedOut ? 'Download timed out' : 'Download failed';
    task.speed = '0 B/s';
    notifyProgress(task);
  } finally {
    clearTimeout(timeout);
    // Cleanup belongs to this generation only. It cannot remove a new run's
    // controller, or revive a task deleted while an async compiler was running.
    if (abortControllers.get(task.id) === controller) abortControllers.delete(task.id);
    if (downloader && chunkDownloaders.get(task.id) === downloader) chunkDownloaders.delete(task.id);
    if (activeRuns.get(task.id) === run) activeRuns.delete(task.id);
    if (tasks.get(task.id) !== task && filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* Deleted or never created. */
      }
    }
  }
}
