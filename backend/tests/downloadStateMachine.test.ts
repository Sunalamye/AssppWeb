import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  dataDir: '',
  autoCleanupDays: 0,
  autoCleanupMaxMB: 0,
  downloads: [] as any[],
  inject: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  config: {
    get dataDir() {
      return mocks.dataDir;
    },
    get autoCleanupDays() {
      return mocks.autoCleanupDays;
    },
    get autoCleanupMaxMB() {
      return mocks.autoCleanupMaxMB;
    },
  },
  DOWNLOAD_TIMEOUT_MS: 60_000,
}));
vi.mock('../src/services/sinfInjector.js', () => ({ inject: mocks.inject }));
vi.mock('../src/services/chunkedDownloader.js', () => ({
  ChunkedDownloader: class {
    signal?: AbortSignal;
    resolve!: () => void;
    reject!: (error: Error) => void;
    aborted = false;
    constructor(
      public url: string,
      public file: string,
      public options: any,
    ) {
      mocks.downloads.push(this);
    }
    download(signal: AbortSignal) {
      this.signal = signal;
      return new Promise<void>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
    abort() {
      this.aborted = true;
    }
  },
}));

let manager: typeof import('../src/services/downloadManager.js');
const software = { id: 1234, bundleID: 'example.fixture', version: '1.0', name: 'Fixture' } as any;
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-state-test-'));
  mocks.autoCleanupDays = 0;
  mocks.autoCleanupMaxMB = 0;
  mocks.downloads.length = 0;
  mocks.inject.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  manager = await import('../src/services/downloadManager.js');
});

afterEach(async () => {
  for (const task of manager.getAllTasks()) manager.deleteTask(task.id);
  for (const download of mocks.downloads) download.reject?.(new DOMException('Fixture cancel', 'AbortError'));
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('download task generations', () => {
  it('waits for a paused writer to settle and prevents its late failure/progress from changing the resumed run', async () => {
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const old = mocks.downloads[0];
    expect(manager.pauseTask(task.id)).toBe(true);
    expect(manager.resumeTask(task.id)).toBe(true);
    expect(task.status).toBe('pending');
    expect(manager.resumeTask(task.id)).toBe(false);
    expect(mocks.downloads).toHaveLength(1);
    old.reject(new DOMException('Fixture abort', 'AbortError'));
    await settle();
    expect(mocks.downloads).toHaveLength(2);
    expect(task.status).toBe('downloading');
    old.options.onProgress({ downloaded: 99, total: 100, speed: 'old' });
    expect(task.progress).toBe(0);
    expect(manager.pauseTask(task.id)).toBe(true);
    expect(mocks.downloads[1].signal.aborted).toBe(true);
    expect(task.status).toBe('paused');
  });

  it('does not resurrect a deleted task or leave an IPA when a compiler finishes after deletion', async () => {
    let finishCompile!: () => void;
    mocks.inject.mockImplementation(
      (_sinfs, file: string) =>
        new Promise<void>((resolve) => {
          finishCompile = () => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'late compiled fixture');
            resolve();
          };
        }),
    );
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', [
      { id: 1, sinf: 'fixture' },
    ] as any);
    const downloader = mocks.downloads[0];
    fs.writeFileSync(downloader.file, 'download fixture');
    downloader.resolve();
    await settle();
    expect(task.status).toBe('injecting');
    expect(manager.deleteTask(task.id)).toBe(true);
    finishCompile();
    await settle();
    expect(manager.getTask(task.id)).toBeUndefined();
    expect(fs.existsSync(downloader.file)).toBe(false);
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line));
    expect(logged.some((event) => event.taskId === task.id && event.taskState === 'completed')).toBe(false);
  });

  it.each([
    ['downloading', 'unlinkSync', 'EACCES'],
    ['downloading', 'readdirSync', 'EACCES'],
    ['downloading', 'rmdirSync', 'ENOTEMPTY'],
    ['injecting', 'unlinkSync', 'EACCES'],
    ['injecting', 'readdirSync', 'EACCES'],
    ['injecting', 'rmdirSync', 'ENOTEMPTY'],
  ] as const)(
    'keeps a %s task failed when deletion hits %s %s, even after the old run finishes',
    async (phase, method, code) => {
      let finishCompile!: () => void;
      mocks.inject.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishCompile = resolve;
          }),
      );
      const task = manager.createTask(
        software,
        'fixture-account',
        'https://fixture.apple.com/file',
        phase === 'injecting' ? ([{ id: 1, sinf: 'fixture' }] as any) : [],
      );
      const downloader = mocks.downloads[0];
      fs.writeFileSync(downloader.file, 'download fixture');
      if (phase === 'injecting') {
        downloader.resolve();
        await settle();
      }
      expect(task.status).toBe(phase);
      const observed: string[] = [];
      manager.addProgressListener(task.id, (updated) => observed.push(updated.status));
      const deletion = vi.spyOn(fs, method).mockImplementationOnce(() => {
        throw Object.assign(new Error('private-delete-filesystem-detail'), { code });
      });
      try {
        expect(() => manager.deleteTask(task.id)).toThrow('Failed to delete download');
      } finally {
        deletion.mockRestore();
      }
      expect(manager.getTask(task.id)).toBe(task);
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Failed to delete download');
      expect(task.speed).toBe('0 B/s');
      expect(downloader.signal.aborted).toBe(true);
      expect(observed).toEqual(['failed']);
      expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, 'tasks.json'), 'utf8'))).toEqual([]);

      const retainedProgress = task.progress;
      downloader.options.onProgress({ downloaded: 99, total: 100, speed: 'late' });
      if (phase === 'injecting') finishCompile();
      else downloader.resolve();
      await settle();
      expect(task.status).toBe('failed');
      expect(task.progress).toBe(retainedProgress);
      expect(task.speed).toBe('0 B/s');
      expect(observed).toEqual(['failed']);
      const logged = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line));
      expect(logged).toContainEqual(
        expect.objectContaining({
          taskId: task.id,
          stage: 'task_cancel',
          outcome: 'failure',
          reason: 'storage',
          taskState: 'failed',
        }),
      );
      expect(
        logged.some((event) => event.taskId === task.id && ['completed', 'deleted'].includes(event.taskState)),
      ).toBe(false);
      expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-delete-filesystem-detail');
    },
  );

  it('removes completed metadata when deleting its file fails, and permits a later delete retry', async () => {
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const downloader = mocks.downloads[0];
    fs.writeFileSync(downloader.file, 'completed fixture');
    downloader.resolve();
    await settle();
    expect(task.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, 'tasks.json'), 'utf8'))).toHaveLength(1);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('private-delete-filesystem-detail'), { code: 'EACCES' });
    });
    try {
      expect(() => manager.deleteTask(task.id)).toThrow('Failed to delete download');
    } finally {
      unlink.mockRestore();
    }
    expect(task.status).toBe('failed');
    expect(JSON.parse(fs.readFileSync(path.join(mocks.dataDir, 'tasks.json'), 'utf8'))).toEqual([]);
    expect(fs.existsSync(downloader.file)).toBe(true);
    expect(manager.deleteTask(task.id)).toBe(true);
    expect(manager.getTask(task.id)).toBeUndefined();
    expect(fs.existsSync(downloader.file)).toBe(false);
  });

  it('still notifies a terminal failure when both file deletion and metadata persistence fail', () => {
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    fs.writeFileSync(mocks.downloads[0].file, 'download fixture');
    const observed: string[] = [];
    manager.addProgressListener(task.id, () => {
      throw new Error('private-observer-detail');
    });
    manager.addProgressListener(task.id, (updated) => observed.push(updated.status));
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('private-delete-filesystem-detail'), { code: 'EACCES' });
    });
    const persist = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('private-persist-filesystem-detail'), { code: 'ENOSPC' });
    });
    try {
      expect(() => manager.deleteTask(task.id)).toThrow('Failed to delete download');
    } finally {
      unlink.mockRestore();
      persist.mockRestore();
    }
    expect(manager.getTask(task.id)).toBe(task);
    expect(task.status).toBe('failed');
    expect(task.speed).toBe('0 B/s');
    expect(observed).toEqual(['failed']);
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({
        taskId: task.id,
        stage: 'package_save',
        outcome: 'failure',
        reason: 'storage',
        taskState: 'failed',
      }),
    );
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-');
  });

  it('continues daily cleanup after a file deletion failure and schedules the next daily cleanup', async () => {
    const first = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const second = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const expiredTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const download of mocks.downloads) {
      fs.writeFileSync(download.file, 'expired fixture');
      fs.utimesSync(download.file, expiredTime, expiredTime);
      download.resolve();
    }
    await settle();
    mocks.autoCleanupDays = 1;
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('private-cleanup-filesystem-detail'), { code: 'EACCES' });
    });
    try {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    } finally {
      unlink.mockRestore();
    }
    expect(first.status).toBe('failed');
    expect(fs.existsSync(first.filePath!)).toBe(true);
    expect(manager.getTask(second.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);

    const third = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const download = mocks.downloads[2];
    fs.writeFileSync(download.file, 'next cleanup fixture');
    fs.utimesSync(download.file, expiredTime, expiredTime);
    download.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(manager.getTask(third.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-cleanup-filesystem-detail');
  });

  it('continues space cleanup after a file deletion failure without failing a new download or counting undeleted bytes', async () => {
    const first = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    const second = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    for (const [index, download] of mocks.downloads.entries()) {
      fs.writeFileSync(download.file, Buffer.alloc(600));
      const modified = new Date(Date.now() - (2 - index) * 60_000);
      fs.utimesSync(download.file, modified, modified);
      download.resolve();
    }
    await settle();
    mocks.autoCleanupMaxMB = 1000 / (1024 * 1024);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('private-cleanup-filesystem-detail'), { code: 'EACCES' });
    });
    let next!: ReturnType<typeof manager.createTask>;
    try {
      next = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
      await settle();
    } finally {
      unlink.mockRestore();
    }
    expect(first.status).toBe('failed');
    expect(fs.existsSync(first.filePath!)).toBe(true);
    expect(manager.getTask(second.id)).toBeUndefined();
    expect(fs.existsSync(second.filePath!)).toBe(false);
    expect(next.status).toBe('downloading');
    expect(mocks.downloads).toHaveLength(3);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-cleanup-filesystem-detail');
  });

  it('contains filesystem setup failures instead of leaving a downloading task or an unhandled rejection', async () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('private-filesystem-detail');
    });
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    await settle();
    mkdir.mockRestore();
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Download failed');
    expect(mocks.downloads).toHaveLength(0);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-filesystem-detail');
  });

  it('does not let a broken progress subscriber fail the task', async () => {
    const task = manager.createTask(software, 'fixture-account', 'https://fixture.apple.com/file', []);
    manager.addProgressListener(task.id, () => {
      throw new Error('observer disconnected');
    });
    const downloader = mocks.downloads[0];
    downloader.options.onProgress({ downloaded: 1, total: 2, speed: '1 B/s' });
    fs.writeFileSync(downloader.file, 'fixture');
    downloader.resolve();
    await settle();
    expect(task.status).toBe('completed');
    const logs = vi.mocked(console.log).mock.calls.flat().join(' ');
    expect(logs).not.toContain('https://fixture.apple.com');
    expect(logs).not.toContain('fixture-account');
  });
});
