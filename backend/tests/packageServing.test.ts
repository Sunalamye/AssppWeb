import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';
import request from 'supertest';
import packageRoutes from '../src/routes/packages.js';
import installRoutes from '../src/routes/install.js';

const fixture = vi.hoisted(() => ({ dataDir: '', tasks: [] as any[] }));
vi.mock('../src/config.js', () => ({
  config: {
    get dataDir() {
      return fixture.dataDir;
    },
    publicBaseUrl: '',
  },
  MIN_ACCOUNT_HASH_LENGTH: 8,
}));
vi.mock('../src/services/downloadManager.js', () => ({
  getAllTasks: () => fixture.tasks,
  deleteTask: vi.fn(),
}));

const app = express();
app.use('/api', packageRoutes, installRoutes);
beforeEach(() => {
  fixture.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-serving-test-'));
  const directory = path.join(fixture.dataDir, 'packages');
  fs.mkdirSync(directory);
  const filePath = path.join(directory, 'fixture.ipa');
  fs.writeFileSync(filePath, 'fixture package bytes');
  fixture.tasks = [
    {
      id: 'fixture',
      status: 'completed',
      accountHash: 'fixture-account',
      filePath,
      software: { name: 'Fixture', bundleID: 'example.fixture', version: '1.0' },
    },
  ];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
});

describe('package file serving', () => {
  it.each(['/api/packages/fixture/file?accountHash=fixture-account', '/api/install/fixture/payload.ipa'])(
    'streams a completed file at %s',
    async (url) => {
      const response = await request(app).get(url);
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('fixture package bytes');
    },
  );

  it.each(['/api/packages/fixture/file?accountHash=fixture-account', '/api/install/fixture/payload.ipa'])(
    'handles a concurrent file deletion before the stream opens at %s',
    async (url) => {
      const stream = new PassThrough();
      // Keep the pre-fix implementation from crashing the test runner. The
      // assertion still requires the route itself to finish the HTTP response.
      stream.on('error', () => {});
      vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
        queueMicrotask(() => stream.destroy(Object.assign(new Error('private-file-path'), { code: 'ENOENT' })));
        return stream as any;
      });
      const response = await request(app).get(url).timeout({ deadline: 1000 });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Package not found' });
      expect(JSON.stringify(response.body)).not.toContain('private-file-path');
      expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-file-path');
    },
  );

  it.each(['manifest.plist', 'url'])(
    'does not advertise installation %s after the package disappears',
    async (endpoint) => {
      fs.unlinkSync(fixture.tasks[0].filePath);
      const response = await request(app).get(`/api/install/fixture/${endpoint}`);
      expect(response.status).toBe(404);
    },
  );

  it('closes an interrupted response after headers without appending an error JSON to IPA bytes', async () => {
    const stream = new PassThrough();
    stream.on('error', () => {});
    vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
      setImmediate(() => {
        stream.write('partial');
        setImmediate(() => stream.destroy(Object.assign(new Error('private-read-error'), { code: 'EIO' })));
      });
      return stream as any;
    });
    await expect(request(app).get('/api/install/fixture/payload.ipa').timeout({ deadline: 1000 })).rejects.toThrow();
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('private-read-error');
    expect(stream.destroyed).toBe(true);
  });
});
