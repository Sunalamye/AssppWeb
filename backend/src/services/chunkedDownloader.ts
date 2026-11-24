import fs from 'fs';
import path from 'path';
import { finished, pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { setTimeout as delay } from 'timers/promises';
import { DOWNLOAD_THREADS, CHUNK_RETRY_COUNT, CHUNK_RETRY_DELAY_MS, MAX_DOWNLOAD_SIZE } from '../config.js';
import { acceptChunk, parseContentLength, parseContentRange } from '../domain/downloadPolicy.js';
import type { DiagnosticDetails, DiagnosticEvent } from '../utils/diagnostics.js';

interface ChunkRange {
  index: number;
  start: number;
  end: number; // inclusive
}

interface ProgressInfo {
  downloaded: number;
  total: number;
  speed: string;
}

type ProgressCallback = (info: ProgressInfo) => void;

/**
 * Multi-threaded HTTP downloader using Range requests.
 * Falls back to single-stream when the server doesn't support Range.
 */
export class ChunkedDownloader {
  private readonly url: string;
  private readonly destPath: string;
  private readonly threads: number;
  private readonly onProgress?: ProgressCallback;
  private readonly onDiagnostic?: (outcome: DiagnosticEvent['outcome'], details: DiagnosticDetails) => void;

  private abortControllers = new Set<AbortController>();
  private aborted = false;
  private chunkBytes: number[] = [];
  private totalSize = 0;
  private lastProgressTime = 0;
  private lastProgressBytes = 0;

  constructor(
    url: string,
    destPath: string,
    options?: {
      threads?: number;
      onProgress?: ProgressCallback;
      onDiagnostic?: (outcome: DiagnosticEvent['outcome'], details: DiagnosticDetails) => void;
    },
  ) {
    this.url = url;
    this.destPath = destPath;
    const threads = options?.threads ?? DOWNLOAD_THREADS;
    this.threads = Number.isSafeInteger(threads) ? Math.max(1, Math.min(32, threads)) : DOWNLOAD_THREADS;
    this.onProgress = options?.onProgress;
    this.onDiagnostic = options?.onDiagnostic;
  }

  private diagnostic(outcome: DiagnosticEvent['outcome'], details: DiagnosticDetails) {
    try {
      this.onDiagnostic?.(outcome, details);
    } catch {
      /* Observers cannot change download behavior. */
    }
  }

  /** Probe the server for Range support and content length. */
  private async probe(signal: AbortSignal): Promise<{
    supportsRange: boolean;
    contentLength: number;
  }> {
    const res = await fetch(this.url, {
      method: 'HEAD',
      signal,
      redirect: 'follow',
      headers: { 'Accept-Encoding': 'identity' },
    });
    if (!res.ok) {
      this.diagnostic('failure', { httpStatus: res.status, reason: 'http_error' });
      throw new Error(`HEAD failed: HTTP ${res.status}`);
    }

    const acceptRanges = res.headers.get('accept-ranges');
    const contentLength = parseContentLength(res.headers.get('content-length')) ?? 0;
    const supportsRange = acceptRanges === 'bytes' && contentLength > 0;

    return { supportsRange, contentLength };
  }

  /** Split total size into chunk ranges. */
  private splitChunks(totalSize: number): ChunkRange[] {
    const chunkSize = Math.ceil(totalSize / this.threads);
    const chunks: ChunkRange[] = [];
    for (let i = 0; i < this.threads; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      if (start > totalSize - 1) break;
      chunks.push({ index: i, start, end });
    }
    return chunks;
  }

  /** Download a single chunk with retries, writing to a .part file. */
  private async downloadChunk(chunk: ChunkRange, signal: AbortSignal): Promise<void> {
    const partPath = `${this.destPath}.part${chunk.index}`;
    const expectedBytes = chunk.end - chunk.start + 1;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < CHUNK_RETRY_COUNT; attempt++) {
      if (this.aborted || signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const ac = new AbortController();
      this.abortControllers.add(ac);
      const onAbort = () => ac.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        this.chunkBytes[chunk.index] = 0;
        const res = await fetch(this.url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: { Range: `bytes=${chunk.start}-${chunk.end}`, 'Accept-Encoding': 'identity' },
        });

        const range = parseContentRange(res.headers.get('content-range'));
        const acceptance = {
          status: res.status,
          validRange: range !== null,
          start: range?.start ?? 0,
          end: range?.end ?? 0,
          total: range?.total ?? 0,
          expectedStart: chunk.start,
          expectedEnd: chunk.end,
          expectedTotal: this.totalSize,
          actualBytes: expectedBytes,
        };
        if (!acceptChunk(acceptance) || !res.body) {
          await res.body?.cancel();
          this.diagnostic('failure', { httpStatus: res.status, reason: 'invalid_response' });
          throw new Error(`Chunk ${chunk.index}: invalid range response`);
        }

        const actualBytes = await this.writeResponse(res, partPath, expectedBytes, ac.signal, (downloaded) => {
          this.chunkBytes[chunk.index] = downloaded;
        });
        if (!acceptChunk({ ...acceptance, actualBytes })) {
          this.diagnostic('failure', { reason: 'invalid_response' });
          throw new Error(`Chunk ${chunk.index}: incomplete range response`);
        }
        return; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (lastErr.name === 'AbortError' || this.aborted) throw lastErr;
        if (attempt < CHUNK_RETRY_COUNT - 1) {
          this.diagnostic('retry', { attempt: attempt + 2, retryDelayMs: CHUNK_RETRY_DELAY_MS, reason: 'network' });
          await delay(CHUNK_RETRY_DELAY_MS, undefined, { signal: ac.signal });
        }
      } finally {
        ac.abort();
        signal.removeEventListener('abort', onAbort);
        this.abortControllers.delete(ac);
      }
    }

    throw lastErr ?? new Error(`Chunk ${chunk.index} failed after retries`);
  }

  /** Merge all .part files into the final destination. */
  private async mergeChunks(chunkCount: number, signal: AbortSignal): Promise<void> {
    const ws = fs.createWriteStream(this.destPath);
    try {
      for (let i = 0; i < chunkCount; i++) {
        const partPath = `${this.destPath}.part${i}`;
        const rs = fs.createReadStream(partPath);
        await pipeline(rs, ws, { end: false, signal });
      }
      const completed = finished(ws);
      ws.end();
      await completed;
    } catch (error) {
      ws.destroy();
      throw error;
    }

    this.cleanPartFiles(chunkCount);
  }

  /** Check the decoded byte count while streaming, and propagate cancellation to the response body. */
  private async writeResponse(
    response: Response,
    destination: string,
    limit: number,
    signal: AbortSignal,
    onBytes: (downloaded: number) => void,
  ): Promise<number> {
    if (!response.body) throw new Error('No response body');
    let downloaded = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > limit) {
          callback(new Error('Download exceeded expected size'));
          return;
        }
        onBytes(downloaded);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      verifier,
      fs.createWriteStream(destination),
      { signal },
    );
    return downloaded;
  }

  /** Remove .part temporary files. */
  private cleanPartFiles(chunkCount: number): void {
    for (let i = 0; i < chunkCount; i++) {
      const partPath = `${this.destPath}.part${i}`;
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** Single-stream fallback download. */
  private async downloadSingleStream(signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url, { signal, redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`Unexpected single-stream HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('No response body');

    const lengthHeader = res.headers.get('content-length');
    const contentLength = parseContentLength(lengthHeader);
    if (
      (lengthHeader !== null && contentLength === null) ||
      (contentLength !== null && contentLength > MAX_DOWNLOAD_SIZE)
    ) {
      await res.body.cancel();
      throw new Error(`File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`);
    }

    this.totalSize = contentLength ?? 0;
    let downloaded = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    const progressInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTime;
      if (elapsed >= 500) {
        const bytesPerSec = ((downloaded - lastBytes) / elapsed) * 1000;
        lastTime = now;
        lastBytes = downloaded;
        this.onProgress?.({
          downloaded,
          total: this.totalSize,
          speed: formatSpeed(bytesPerSec),
        });
      }
    }, 500);

    try {
      downloaded = await this.writeResponse(res, this.destPath, contentLength ?? MAX_DOWNLOAD_SIZE, signal, (bytes) => {
        downloaded = bytes;
      });
      if (downloaded === 0 || (contentLength !== null && downloaded !== contentLength)) {
        this.diagnostic('failure', { reason: 'invalid_response' });
        throw new Error('Incomplete single-stream response');
      }
    } finally {
      clearInterval(progressInterval);
    }

    this.onProgress?.({ downloaded, total: this.totalSize, speed: '0 B/s' });
  }

  /**
   * Execute the download.
   * Probes for Range support, then either downloads in parallel chunks
   * or falls back to single-stream.
   */
  async download(signal: AbortSignal): Promise<void> {
    if (this.aborted || signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.runDownload(controller.signal);
    } catch (error) {
      try {
        fs.unlinkSync(this.destPath);
      } catch {
        /* Never created or already removed. */
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.abortControllers.delete(controller);
    }
  }

  private async runDownload(signal: AbortSignal): Promise<void> {
    let supportsRange = false;
    let contentLength = 0;
    try {
      const probeResult = await this.probe(signal);
      supportsRange = probeResult.supportsRange;
      contentLength = probeResult.contentLength;
    } catch {
      if (this.aborted || signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // HEAD failed — fall back to single-stream
      this.diagnostic('transition', { reason: 'fallback' });
    }

    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(`File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`);
    }

    if (!supportsRange || this.threads <= 1) {
      await this.downloadSingleStream(signal);
      return;
    }

    this.totalSize = contentLength;
    const chunks = this.splitChunks(contentLength);
    this.chunkBytes = new Array(chunks.length).fill(0);

    this.lastProgressTime = Date.now();
    this.lastProgressBytes = 0;
    const progressInterval = setInterval(() => {
      const now = Date.now();
      const totalDownloaded = this.chunkBytes.reduce((a, b) => a + b, 0);
      const elapsed = now - this.lastProgressTime;

      let speed = '0 B/s';
      if (elapsed > 0) {
        const bytesPerSec = ((totalDownloaded - this.lastProgressBytes) / elapsed) * 1000;
        speed = formatSpeed(bytesPerSec);
      }
      this.lastProgressTime = now;
      this.lastProgressBytes = totalDownloaded;

      this.onProgress?.({
        downloaded: totalDownloaded,
        total: this.totalSize,
        speed,
      });
    }, 500);

    const pendingChunks = chunks.map((chunk) => this.downloadChunk(chunk, signal));
    try {
      await Promise.all(pendingChunks);

      clearInterval(progressInterval);
      await this.mergeChunks(chunks.length, signal);

      this.onProgress?.({
        downloaded: this.totalSize,
        total: this.totalSize,
        speed: '0 B/s',
      });
    } catch (err) {
      clearInterval(progressInterval);
      // Promise.all rejects on the first failure. Stop and settle every writer
      // before cleanup or a resumed task reuses these same .part paths.
      this.abort();
      await Promise.allSettled(pendingChunks);
      this.cleanPartFiles(chunks.length);
      throw err;
    }
  }

  /** Abort all active connections and clean up temporary files. */
  abort(): void {
    this.aborted = true;
    for (const ac of this.abortControllers) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    this.abortControllers.clear();

    // Clean up any .part files by scanning directory
    try {
      const dir = path.dirname(this.destPath);
      const base = path.basename(this.destPath);
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith(base + '.part')) {
            try {
              fs.unlinkSync(path.join(dir, entry));
            } catch {
              // best-effort
            }
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
