import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDelete, apiGet, apiPost } from '../../src/api/client';
import { deleteDownload, fetchDownloads, pauseDownload, resumeDownload, startDownload } from '../../src/api/downloads';
import { createDiagnosticFlow } from '../../src/utils/diagnostics';
import type { Software } from '../../src/types';

vi.mock('../../src/api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe('download API correlation', () => {
  it('passes the action flow only as a header for list, create, pause, resume, and delete', async () => {
    const flow = createDiagnosticFlow('download');
    const headers = { 'X-Asspp-Flow-Id': flow.id };
    const input = {
      software: { id: 123, version: '1.0' } as Software,
      accountHash: 'account-hash',
      downloadURL: 'https://example.apple.com/private-package',
      sinfs: [{ id: 1, sinf: 'private-signature' }],
    };
    await fetchDownloads(['account-hash'], flow);
    await startDownload(input, flow);
    await pauseDownload('task-id', 'account-hash', flow);
    await resumeDownload('task-id', 'account-hash', flow);
    await deleteDownload('task-id', 'account-hash', flow);
    expect(apiGet).toHaveBeenCalledWith('/api/downloads?accountHashes=account-hash', headers);
    expect(apiPost).toHaveBeenNthCalledWith(1, '/api/downloads', input, headers);
    expect(apiPost).toHaveBeenNthCalledWith(
      2,
      '/api/downloads/task-id/pause?accountHash=account-hash',
      undefined,
      headers,
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      3,
      '/api/downloads/task-id/resume?accountHash=account-hash',
      undefined,
      headers,
    );
    expect(apiDelete).toHaveBeenCalledWith('/api/downloads/task-id?accountHash=account-hash', headers);
    expect(JSON.stringify(input)).not.toContain(flow.id);
  });

  it('does not query the backend for an empty account set', async () => {
    await expect(fetchDownloads([], createDiagnosticFlow('download'))).resolves.toEqual([]);
    expect(apiGet).not.toHaveBeenCalled();
  });
});
