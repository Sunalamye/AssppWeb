/** Executable counterparts of formal/Asspp.lean. Keep the differential gate in sync. */
export type DownloadState = 'pending' | 'downloading' | 'paused' | 'injecting' | 'completed' | 'failed' | 'deleted';
export type DownloadEvent = 'start' | 'pause' | 'resume' | 'compile' | 'complete' | 'fail' | 'delete' | 'deleteFailed';

/** `deleted` is a tombstone in the model; the manager removes that task from its map. */
export function transitionDownload(
  state: DownloadState,
  event: DownloadEvent,
  currentGeneration: boolean,
): DownloadState {
  if (event === 'delete') return 'deleted';
  if (event === 'deleteFailed') return state === 'deleted' ? state : 'failed';
  if (event === 'pause') return state === 'downloading' ? 'paused' : state;
  if (event === 'resume') return state === 'paused' ? 'pending' : state;
  if (!currentGeneration) return state;

  switch (event) {
    case 'start':
      return state === 'pending' ? 'downloading' : state;
    case 'compile':
      return state === 'downloading' ? 'injecting' : state;
    case 'complete':
      return state === 'downloading' || state === 'injecting' ? 'completed' : state;
    case 'fail':
      return state === 'pending' || state === 'downloading' || state === 'injecting' ? 'failed' : state;
  }
}

export interface ChunkAcceptance {
  status: number;
  validRange: boolean;
  start: number;
  end: number;
  total: number;
  expectedStart: number;
  expectedEnd: number;
  expectedTotal: number;
  actualBytes: number;
}

export function acceptChunk(input: ChunkAcceptance): boolean {
  const natural = (value: number) => Number.isSafeInteger(value) && value >= 0;
  return (
    input.status === 206 &&
    input.validRange &&
    [
      input.start,
      input.end,
      input.total,
      input.expectedStart,
      input.expectedEnd,
      input.expectedTotal,
      input.actualBytes,
    ].every(natural) &&
    input.expectedStart <= input.expectedEnd &&
    input.expectedEnd < input.expectedTotal &&
    input.start === input.expectedStart &&
    input.end === input.expectedEnd &&
    input.total === input.expectedTotal &&
    input.actualBytes === input.expectedEnd - input.expectedStart + 1
  );
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = value?.trim().match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/i);
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every((number) => Number.isSafeInteger(number) && number >= 0)) return null;
  return { start, end, total };
}

export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value.trim())) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
