import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChunkedDownloader } from '../src/services/chunkedDownloader.js';

vi.mock('../src/config.js', () => ({
  DOWNLOAD_THREADS: 2,
  CHUNK_RETRY_COUNT: 1,
  CHUNK_RETRY_DELAY_MS: 1,
  MAX_DOWNLOAD_SIZE: 1024,
}));

let directory: string;
let destination: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-integrity-test-'));
  destination = path.join(directory, 'fixture.ipa');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function responses(first: () => Response, second?: () => Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    if (options?.method === 'HEAD') {
      return new Response(null, { headers: { 'Content-Length': '8', 'Accept-Ranges': 'bytes' } });
    }
    return (options?.headers as Record<string, string>).Range === 'bytes=0-3'
      ? first()
      : (second?.() ?? new Response('efgh', { status: 206, headers: { 'Content-Range': 'bytes 4-7/8' } }));
  });
}

describe('download byte-range integrity', () => {
  it('assembles the requested ranges in order after checking every response', async () => {
    responses(() => new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 0-3/8' } }));
    await new ChunkedDownloader('https://fixture.apple.com/file', destination).download(new AbortController().signal);
    expect(fs.readFileSync(destination, 'utf8')).toBe('abcdefgh');
    expect(fs.readdirSync(directory)).toEqual(['fixture.ipa']);
  });

  it.each([
    ['ignores Range and returns a whole HTTP 200 document', 200, 'abcdefgh', undefined],
    ['omits Content-Range', 206, 'abcd', undefined],
    ['returns a different range of the same length', 206, 'efgh', 'bytes 4-7/8'],
    ['changes the resource total between chunks', 206, 'abcd', 'bytes 0-3/9'],
    ['returns a short chunk', 206, 'abc', 'bytes 0-3/8'],
    ['returns an oversized chunk', 206, 'abcde', 'bytes 0-3/8'],
    ['returns a malformed numeric range', 206, 'abcd', 'bytes 0-3/8tail'],
  ] as const)('rejects an incomplete or incompatible response that %s', async (_label, status, body, contentRange) => {
    responses(() => new Response(body, { status, headers: contentRange ? { 'Content-Range': contentRange } : {} }));
    await expect(
      new ChunkedDownloader('https://fixture.apple.com/file', destination).download(new AbortController().signal),
    ).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('rejects a partial response to a single-stream request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) =>
      options?.method === 'HEAD'
        ? new Response(null, { headers: { 'Content-Length': '8' } })
        : new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 0-3/8' } }),
    );
    await expect(
      new ChunkedDownloader('https://fixture.apple.com/file', destination).download(new AbortController().signal),
    ).rejects.toThrow();
  });

  it('rejects a single stream that ends before its declared content length', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) =>
      options?.method === 'HEAD'
        ? new Response(null, { headers: { 'Content-Length': '8' } })
        : new Response('abc', { headers: { 'Content-Length': '8' } }),
    );
    await expect(
      new ChunkedDownloader('https://fixture.apple.com/file', destination).download(new AbortController().signal),
    ).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });
});
