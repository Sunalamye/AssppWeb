import { afterEach, expect, it, vi } from 'vitest';
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
afterEach(() => vi.restoreAllMocks());

it('does not start a probe or fallback request after cancellation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const controller = new AbortController();
  controller.abort();
  const downloader = new ChunkedDownloader('https://fixture.apple.com/file', '/unused-fixture.ipa');
  await expect(downloader.download(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});

it('aborts and settles sibling chunks before rejecting the download and releasing its file paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-chunk-test-'));
  let siblingSettled = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    if (options?.method === 'HEAD')
      return new Response(null, { headers: { 'Content-Length': '8', 'Accept-Ranges': 'bytes' } });
    const range = (options?.headers as Record<string, string>).Range;
    if (range === 'bytes=0-3') return new Response(null, { status: 500 });
    return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener(
        'abort',
        () => {
          siblingSettled = true;
          reject(new DOMException('Fixture cancellation', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  try {
    const downloader = new ChunkedDownloader('https://fixture.apple.com/file', path.join(directory, 'fixture.ipa'), {
      threads: 2,
    });
    await expect(downloader.download(new AbortController().signal)).rejects.toThrow();
    expect(siblingSettled).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
