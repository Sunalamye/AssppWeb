import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { StoreProofClient } from '../../src/apple/storeProof';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const headers = { 'X-Apple-AMD': 'proof', 'X-Apple-AMD-M': 'machine-proof' };
const endpoint = 'https://auth.itunes.apple.com/auth/v1/native';
let counter = 0;
const device = () => `12345678${(++counter).toString(16).padStart(4, '0')}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Store proof browser state', () => {
  it('serializes concurrent clients for one device and persists each updated state', async () => {
    const calls: Record<string, any>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/health')) return Response.json({ status: 'ready' });
        const input = JSON.parse(String(options?.body));
        calls.push(input);
        return Response.json({ mode: 'store', state: `state-${calls.length}`, headers });
      }),
    );
    const guid = device();
    await new StoreProofClient(guid).bootstrap(endpoint);
    await Promise.all([
      new StoreProofClient(guid).proof(endpoint),
      new StoreProofClient(guid.toUpperCase()).proof(endpoint),
    ]);
    await new StoreProofClient(guid).proof(endpoint);
    expect(calls.map((call) => call.state)).toEqual([undefined, 'state-1', 'state-2', 'state-3']);
    expect(calls.every((call) => call.deviceId === guid.toUpperCase())).toBe(true);
  });

  it('isolates provisioning state between device identities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith('/health') ? { status: 'ready' } : { mode: 'store', state: 'private-machine-state', headers },
        ),
      ),
    );
    await new StoreProofClient(device()).bootstrap(endpoint);
    await expect(new StoreProofClient(device()).proof(endpoint)).rejects.toThrow('Re-authenticate');
  });

  it('clears pending writes before allowing another client to initialize a fresh database', async () => {
    const calls: Record<string, any>[] = [];
    let releaseProof: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/health')) return Response.json({ status: 'ready' });
        const input = JSON.parse(String(options?.body));
        calls.push(input);
        if (input.operation === 'proof') return new Promise<Response>((resolve) => (releaseProof = resolve));
        return Response.json({ mode: 'store', state: `state-${calls.length}`, headers });
      }),
    );
    const guid = device();
    const client = new StoreProofClient(guid);
    await client.bootstrap(endpoint);
    const proof = client.proof(endpoint);
    await vi.waitFor(() => expect(releaseProof).toBeTypeOf('function'));
    const cleared = StoreProofClient.clearAll();
    const restarted = new StoreProofClient(guid).bootstrap(endpoint);
    expect(calls).toHaveLength(2);
    releaseProof!(Response.json({ state: 'late-write-before-clear', headers }));
    await Promise.all([proof, cleared, restarted]);
    expect(calls.map((call) => call.state)).toEqual([undefined, 'state-1', undefined]);
    expect(calls[2].operation).toBe('bootstrap');
  });

  it('closes and invalidates its cached connection when another tab deletes the database', async () => {
    const calls: Record<string, any>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/health')) return Response.json({ status: 'ready' });
        calls.push(JSON.parse(String(options?.body)));
        return Response.json({ mode: 'store', state: 'state', headers });
      }),
    );
    const client = new StoreProofClient(device());
    await client.bootstrap(endpoint);
    await deleteDB('asspp-store-proof');
    await client.bootstrap(endpoint);
    expect(calls.map((call) => call.state)).toEqual([undefined, undefined]);
  });

  it('retains the last valid state when proof generation fails', async () => {
    const calls: Record<string, any>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/health')) return Response.json({ status: 'ready' });
        calls.push(JSON.parse(String(options?.body)));
        if (calls.length === 2) return Response.json({ error: { code: 'PROOF_FAILED' } }, { status: 502 });
        return Response.json({ mode: 'store', state: 'last-valid-state', headers });
      }),
    );
    const client = new StoreProofClient(device());
    await client.bootstrap(endpoint);
    await expect(client.proof(endpoint)).rejects.toThrow('PROOF_FAILED');
    await expect(client.proof(endpoint)).resolves.toEqual(headers);
    expect(calls.map((call) => call.state)).toEqual([undefined, 'last-valid-state', 'last-valid-state']);
  });

  it.each(['proof', 'kbsync'] as const)(
    'waits for helper readiness before %s after a server restart',
    async (operation) => {
      const calls: string[] = [];
      let restarting = false;
      let healthCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options?: RequestInit) => {
          if (url.endsWith('/health')) {
            if (restarting && ++healthCalls === 1) return Response.json({ status: 'loading' }, { status: 503 });
            return Response.json({ status: 'ready' });
          }
          const input = JSON.parse(String(options?.body));
          calls.push(input.operation);
          return Response.json({ mode: 'store', state: 'state', headers, kbsync: 'key-sync-data' });
        }),
      );
      const client = new StoreProofClient(device());
      await client.bootstrap(endpoint);
      restarting = true;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = operation === 'proof' ? client.proof(endpoint) : client.kbsync('123456');
      await vi.waitFor(() => expect(healthCalls).toBe(1));
      expect(calls).toEqual(['bootstrap']);
      await vi.advanceTimersByTimeAsync(3000);
      await pending;
      expect(calls).toEqual(['bootstrap', operation]);
      expect(healthCalls).toBe(2);
    },
  );

  it('allows the initial helper connection to become available while failing immediately on permanent errors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let healthCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/health')) {
          healthCalls++;
          if (healthCalls === 1) throw new TypeError('Connection unavailable');
          if (healthCalls === 2) return new Response('', { status: 502 });
          return Response.json({ status: 'ready' });
        }
        return Response.json({ mode: 'store', state: 'state', headers });
      }),
    );
    const bootstrapped = new StoreProofClient(device()).bootstrap(endpoint);
    await vi.waitFor(() => expect(healthCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(6000);
    await bootstrapped;
    expect(healthCalls).toBe(3);

    vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'error' }, { status: 503 }));
    await expect(new StoreProofClient(device()).bootstrap(endpoint)).rejects.toThrow('unavailable');
  });

  it.each([
    'http://auth.itunes.apple.com/auth/v1/native',
    'https://example.invalid/auth/v1/native',
    'https://auth.itunes.apple.com/unrelated',
    'https://user@auth.itunes.apple.com/auth/v1/native',
    'https://auth.itunes.apple.com/auth/v1/native#fragment',
    'https://downloaddispatch.itunes.apple.com/r/redownload?guid=1&guid=2',
    'https://downloaddispatch.itunes.apple.com/r/redownload?token=secret',
  ])('rejects unapproved endpoints before contacting the helper: %s', async (url) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(new StoreProofClient(device()).bootstrap(url)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects helper headers that could overwrite cookies or authorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith('/health')
            ? { status: 'ready' }
            : { mode: 'store', state: 'state', headers: { ...headers, Cookie: 'secret' } },
        ),
      ),
    );
    await expect(new StoreProofClient(device()).bootstrap(endpoint)).rejects.toThrow(
      'Invalid device verification header',
    );
  });

  it('does not reflect raw helper error bodies or state into the user-visible error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health')
          ? Response.json({ status: 'ready' })
          : Response.json({ error: { code: 'FAILED', message: 'secret-state-and-cookie' } }, { status: 502 }),
      ),
    );
    try {
      await new StoreProofClient(device()).bootstrap(endpoint);
      throw new Error('Expected failure');
    } catch (error) {
      expect(String(error)).toContain('FAILED');
      expect(String(error)).not.toContain('secret-state-and-cookie');
    }
  });
});
