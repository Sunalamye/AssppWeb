import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DownloadList from '../../src/components/Download/DownloadList';
import PackageDetail from '../../src/components/Download/PackageDetail';
import { attachDiagnosticId, createDiagnosticFlow } from '../../src/utils/diagnostics';
import type { Account, DownloadTask } from '../../src/types';

const mocks = vi.hoisted(() => ({
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
  startDownload: vi.fn(),
  loadVersions: vi.fn(),
  lookupApp: vi.fn(),
  addToast: vi.fn(),
  navigate: vi.fn(),
  tasks: [] as DownloadTask[],
  accounts: [] as Account[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ id: 'task' }),
  useLocation: () => ({ search: '' }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/components/Layout/PageContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/components/Download/PackageQuickActions', () => ({ default: () => null }));
vi.mock('../../src/components/Download/DownloadItem', () => ({
  default: ({
    task,
    onDelete,
    onPause,
    onResume,
  }: {
    task: DownloadTask;
    onDelete: (id: string) => void;
    onPause: (id: string) => void;
    onResume: (id: string) => void;
  }) => (
    <div>
      <button onClick={() => onDelete(task.id)}>delete task</button>
      <button onClick={() => onPause(task.id)}>pause task</button>
      <button onClick={() => onResume(task.id)}>resume task</button>
    </div>
  ),
}));
vi.mock('../../src/hooks/useDownloads', () => ({
  useDownloads: () => ({ ...mocks, loading: false, hashToEmail: { hash: 'account@example.invalid' } }),
}));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ accounts: mocks.accounts }) }));
vi.mock('../../src/hooks/useDownloadAction', () => ({ useDownloadAction: () => mocks }));
vi.mock('../../src/api/search', () => ({ lookupApp: (...args: unknown[]) => mocks.lookupApp(...args) }));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));

const task = {
  id: 'task',
  accountHash: 'hash',
  status: 'completed',
  progress: 100,
  hasFile: true,
  software: {
    id: 123,
    name: 'App',
    bundleID: 'example.app',
    version: '1.0',
    artworkUrl: '',
    artistName: 'Example',
    fileSizeBytes: '100',
  },
} as DownloadTask;
const newer = { ...task.software, version: '2.0' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tasks = [task];
  mocks.accounts = [{ email: 'account@example.invalid', store: '143441' } as Account];
  mocks.deleteDownload.mockResolvedValue(undefined);
  mocks.pauseDownload.mockResolvedValue(undefined);
  mocks.resumeDownload.mockResolvedValue(undefined);
  mocks.startDownload.mockResolvedValue(true);
  mocks.loadVersions.mockResolvedValue({ versions: ['456'] });
  mocks.lookupApp.mockResolvedValue(newer);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('download action outcomes', () => {
  it('waits for deletion before reporting success', async () => {
    let finish!: () => void;
    mocks.deleteDownload.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<DownloadList />);
    fireEvent.click(screen.getByRole('button', { name: 'delete task' }));
    expect(mocks.deleteDownload).toHaveBeenCalledWith('task');
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.addToast).toHaveBeenCalledWith('toast.msg', 'success', 'toast.title.deleteSuccess');
  });

  it.each([
    ['delete task', 'deleteDownload'],
    ['pause task', 'pauseDownload'],
    ['resume task', 'resumeDownload'],
  ] as const)('catches %s failures and retains the task flow identifier', async (button, operation) => {
    const flow = createDiagnosticFlow('download');
    mocks[operation].mockRejectedValue(attachDiagnosticId(new Error('Mutation unavailable'), flow.id));
    render(<DownloadList />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith('Mutation unavailable\n[flow: ' + flow.id + ']', 'error'),
    );
    expect(mocks.addToast).not.toHaveBeenCalledWith(expect.any(String), 'success', expect.any(String));
  });

  it('keeps the previous completed IPA after enqueueing an update', async () => {
    render(<PackageDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'downloads.package.checkUpdate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'downloads.package.update' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/downloads'));
    expect(mocks.startDownload).toHaveBeenCalledWith(mocks.accounts[0], newer, undefined);
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
  });

  it('does not enqueue after cancellation while a batch version lookup is in flight', async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof newer) => void;
    mocks.lookupApp.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<DownloadList />);
    fireEvent.click(screen.getByRole('button', { name: 'downloads.checkUpdates' }));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.lookupApp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'settings.data.cancel' }));
    await act(async () => finish(newer));
    expect(mocks.startDownload).not.toHaveBeenCalled();
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'downloads.checkUpdates' })).toBeEnabled();
  });
});
