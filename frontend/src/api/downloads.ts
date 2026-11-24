import { apiGet, apiPost, apiDelete } from './client';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { DownloadTask, Software, Sinf } from '../types';

export interface StartDownloadInput {
  software: Software;
  accountHash: string;
  downloadURL: string;
  sinfs: Sinf[];
  iTunesMetadata?: string;
}

function diagnosticHeaders(flow?: DiagnosticFlow): Record<string, string> {
  return flow ? { 'X-Asspp-Flow-Id': flow.id } : {};
}

export async function fetchDownloads(accountHashes: string[], flow?: DiagnosticFlow): Promise<DownloadTask[]> {
  if (accountHashes.length === 0) return [];
  const params = new URLSearchParams({
    accountHashes: accountHashes.join(','),
  });
  return apiGet<DownloadTask[]>(`/api/downloads?${params}`, diagnosticHeaders(flow));
}

export async function startDownload(data: StartDownloadInput, flow?: DiagnosticFlow): Promise<DownloadTask> {
  return apiPost<DownloadTask>('/api/downloads', data, diagnosticHeaders(flow));
}

export async function pauseDownload(id: string, accountHash: string, flow?: DiagnosticFlow): Promise<void> {
  const params = new URLSearchParams({ accountHash });
  await apiPost(`/api/downloads/${id}/pause?${params}`, undefined, diagnosticHeaders(flow));
}

export async function resumeDownload(id: string, accountHash: string, flow?: DiagnosticFlow): Promise<void> {
  const params = new URLSearchParams({ accountHash });
  await apiPost(`/api/downloads/${id}/resume?${params}`, undefined, diagnosticHeaders(flow));
}

export async function deleteDownload(id: string, accountHash: string, flow?: DiagnosticFlow): Promise<void> {
  const params = new URLSearchParams({ accountHash });
  await apiDelete(`/api/downloads/${id}?${params}`, diagnosticHeaders(flow));
}
