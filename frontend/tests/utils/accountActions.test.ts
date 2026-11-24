import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAccountAction, withAccountsPaused } from '../../src/utils/accountActions';
import { createDiagnosticFlow, getDiagnosticEvents, clearDiagnosticEvents } from '../../src/utils/diagnostics';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

afterEach(() => {
  vi.useRealTimers();
  clearDiagnosticEvents();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});

describe('account operation ownership', () => {
  it('blocks the same account across views while allowing a different account', async () => {
    const pending = deferred<number>();
    const first = withAccountAction('User@example.invalid', createDiagnosticFlow('login'), () => pending.promise);
    await expect(
      withAccountAction(' user@example.invalid ', createDiagnosticFlow('download'), async () => 2),
    ).rejects.toMatchObject({ diagnostics: { reason: 'busy' }, diagnosticId: expect.any(String) });
    await expect(
      withAccountAction('other@example.invalid', createDiagnosticFlow('login'), async () => 3),
    ).resolves.toBe(3);
    pending.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(withAccountAction('User@example.invalid', createDiagnosticFlow('login'), async () => 4)).resolves.toBe(
      4,
    );
  });

  it('waits for the full account write and blocks new work while clearing', async () => {
    const pending = deferred<void>();
    const clear = vi.fn().mockResolvedValue('cleared');
    const active = withAccountAction('a@example.invalid', createDiagnosticFlow('login'), () => pending.promise);
    const paused = withAccountsPaused(createDiagnosticFlow('settings'), clear);
    expect(clear).not.toHaveBeenCalled();
    await expect(
      withAccountAction('b@example.invalid', createDiagnosticFlow('login'), async () => undefined),
    ).rejects.toMatchObject({ diagnostics: { reason: 'busy' } });
    pending.resolve();
    await active;
    await expect(paused).resolves.toBe('cleared');
    expect(clear).toHaveBeenCalledOnce();
    await expect(withAccountAction('b@example.invalid', createDiagnosticFlow('login'), async () => 1)).resolves.toBe(1);
  });

  it('releases ownership when account work or reset fails', async () => {
    await expect(
      withAccountAction('a@example.invalid', createDiagnosticFlow('login'), async () => {
        throw new Error('Synthetic');
      }),
    ).rejects.toThrow('Synthetic');
    await expect(
      withAccountsPaused(createDiagnosticFlow('settings'), async () => {
        throw new Error('Synthetic reset');
      }),
    ).rejects.toThrow('Synthetic reset');
    await expect(withAccountAction('a@example.invalid', createDiagnosticFlow('login'), async () => 1)).resolves.toBe(1);
  });

  it('honors an account lock held by another tab without running protocol work', async () => {
    const action = vi.fn();
    const request = vi.fn(async (_name, options, callback) => callback(options.mode === 'shared' ? {} : null));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    await expect(withAccountAction('a@example.invalid', createDiagnosticFlow('login'), action)).rejects.toMatchObject({
      diagnostics: { reason: 'busy' },
    });
    expect(action).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('times out only the lock wait and never starts the queued destructive operation', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const active = withAccountAction('a@example.invalid', createDiagnosticFlow('login'), () => pending.promise);
    const clear = vi.fn();
    const pauseResult = withAccountsPaused(createDiagnosticFlow('settings'), clear).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pauseResult).toMatchObject({ name: 'TimeoutError' });
    expect(clear).not.toHaveBeenCalled();
    expect(getDiagnosticEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'lock', outcome: 'failure', reason: 'lock_timeout' })]),
    );
    pending.resolve();
    await active;
    await expect(withAccountsPaused(createDiagnosticFlow('settings'), async () => true)).resolves.toBe(true);
  });
});
