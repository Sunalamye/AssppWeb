import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), configure: vi.fn(), token: 'first-token' }));
vi.mock('libcurl.js/bundled', () => ({ libcurl: { load_wasm: mocks.load, set_websocket: mocks.configure } }));
vi.mock('../../src/components/Auth/PasswordGate', () => ({ getAccessToken: () => mocks.token }));

describe('libcurl initialization lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.load.mockReset();
    mocks.configure.mockReset();
    mocks.token = 'first-token';
  });
  afterEach(() => vi.useRealTimers());

  it('shares an in-flight initialization', async () => {
    let complete!: () => void;
    mocks.load.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    const first = initLibcurl();
    const second = initLibcurl();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([first, second]);
  });

  it('releases a rejected initialization so later attempts are not permanently poisoned', async () => {
    mocks.load.mockRejectedValueOnce(new Error('load failed')).mockResolvedValueOnce(undefined);
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    await expect(initLibcurl()).rejects.toThrow('load failed');
    await expect(initLibcurl()).resolves.toBeUndefined();
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('updates the Wisp connection configuration after an access token changes without logging the token', async () => {
    mocks.load.mockResolvedValue(undefined);
    const flow = { id: '148e4e1c-bc43-43a8-b2a3-458c3b574d1f', log: vi.fn() };
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    await initLibcurl(flow);
    mocks.token = 'renewed-secret';
    await initLibcurl(flow);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.configure).toHaveBeenCalledTimes(2);
    expect(mocks.configure.mock.calls[1][0]).toContain('renewed-secret');
    expect(JSON.stringify(flow.log.mock.calls)).not.toContain('renewed-secret');
  });

  it('bounds a loader that never resolves', async () => {
    vi.useFakeTimers();
    mocks.load.mockReturnValue(new Promise(() => {}));
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    const waiting = expect(initLibcurl()).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await waiting;
    mocks.load.mockResolvedValue(undefined);
    await expect(initLibcurl()).resolves.toBeUndefined();
  });
});
