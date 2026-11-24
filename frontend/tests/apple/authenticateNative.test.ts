import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Authenticator } from '../../src/apple/authenticate';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { connectSAP } from '../../src/apple/sap';
import {
  createDiagnosticFlow,
  getDiagnosticEvents,
  clearDiagnosticEvents,
  getDiagnosticId,
} from '../../src/utils/diagnostics';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/sap', () => ({ connectSAP: vi.fn() }));
vi.mock('../../src/apple/bag', async (original) => ({
  ...(await original<typeof import('../../src/apple/bag')>()),
  fetchBag: vi.fn(),
}));

const endpoint = 'https://auth.itunes.apple.com/auth/v1/native';
const proofHeaders = { 'X-Apple-AMD': 'fresh-proof', 'X-Apple-AMD-M': 'machine-proof' };
const reply = (body: Record<string, unknown> | null, headers: Record<string, string> = {}, status = 200) => ({
  status,
  statusText: '',
  headers,
  rawHeaders: [] as [string, string][],
  body: body ? buildPlist(body) : '',
});
const success = () =>
  reply(
    { passwordToken: 'private-token' },
    {
      'x-dsid': '123456',
      'x-apple-request-store-front': '143470-1,29',
    },
  );
let device = 0;
const newAuth = () => new Authenticator(`aabbccdd${(++device).toString(16).padStart(4, '0')}`);

function helper(mode: 'store' | 'bootstrap' = 'store') {
  const calls: Record<string, any>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/store-proof/health') return Response.json({ status: 'ready' });
      expect(url).toBe('/api/store-proof');
      const input = JSON.parse(String(options?.body));
      calls.push(input);
      switch (input.operation) {
        case 'bootstrap':
          return Response.json({
            state: 'initial-state',
            mode,
            headers: { ...proofHeaders, 'X-Apple-I-MD-RINFO': '123', 'X-Mme-Device-Id': 'device-identity' },
          });
        case 'proof':
          return Response.json({
            state: `state-${calls.length}`,
            headers: { ...proofHeaders, 'X-Apple-AMD': `proof-${calls.length}` },
          });
        case 'provision-start':
          return Response.json({
            pending: 'pending-session',
            clientData: 'Y3BpbQ==',
            kbsync: 'a2JzeW5j',
            identityHeaders: { 'X-Mme-Device-Id': 'device-identity' },
          });
        case 'provision-finish':
          return Response.json({ state: 'store-state' });
        default:
          throw new Error('Unexpected helper operation');
      }
    }),
  );
  return calls;
}

describe('native authentication with machine provisioning', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchBag).mockResolvedValue({ authURL: endpoint });
    const sign = vi.fn(async () => Uint8Array.of(sign.mock.calls.length));
    vi.mocked(connectSAP).mockResolvedValue({ sign });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the same account storefront when reauthentication only returns a request echo', async () => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue(success());
    const auth = new Authenticator('aabbccddee91', [], undefined, {
      directoryServicesIdentifier: '123456',
      store: '143462',
      storeFront: '143462-1,29',
    });
    await expect(auth.authenticate('private@example.invalid', 'private-password')).resolves.toMatchObject({
      store: '143462',
      storeFront: '143462-1,29',
    });
  });

  it('accepts an authoritative storefront assignment instead of preserving the saved value', async () => {
    helper();
    const response = success();
    response.headers['x-set-apple-store-front'] = '143441-1,34';
    vi.mocked(appleRequest).mockResolvedValue(response);
    const auth = new Authenticator('aabbccddee92', [], undefined, {
      directoryServicesIdentifier: '123456',
      store: '143462',
      storeFront: '143462-1,29',
    });
    await expect(auth.authenticate('private@example.invalid', 'private-password')).resolves.toMatchObject({
      store: '143441',
      storeFront: '143441-1,34',
    });
  });

  it('never reuses storefront state belonging to a different DSID', async () => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue(success());
    const auth = new Authenticator('aabbccddee93', [], undefined, {
      directoryServicesIdentifier: '654321',
      store: '143462',
      storeFront: '143462-1,29',
    });
    await expect(auth.authenticate('private@example.invalid', 'private-password')).resolves.toMatchObject({
      store: '143470',
      storeFront: '143470-1,29',
    });
  });

  it('keeps a storefront assignment across a later redirect response that only echoes routing', async () => {
    helper();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(
        reply(
          null,
          {
            location: 'https://p47-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
            'x-set-apple-store-front': '143441-1,34',
          },
          302,
        ),
      )
      .mockResolvedValueOnce(success());
    const account = await newAuth().authenticate('private@example.invalid', 'private-password');
    expect(account.storeFront).toBe('143441-1,34');
  });

  it('completes RP -> SP -> browser finish -> 2FA without sending Apple credentials to the helper', async () => {
    const calls = helper('bootstrap');
    const signers = [1, 2, 3].map((value) => ({ sign: vi.fn(async (_body: Uint8Array) => Uint8Array.of(value)) }));
    vi.mocked(connectSAP)
      .mockResolvedValueOnce(signers[0])
      .mockResolvedValueOnce(signers[1])
      .mockResolvedValueOnce(signers[2]);
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        ...reply(null, { 'x-apple-amd-action': 'RP' }, 204),
        rawHeaders: [['set-cookie', 'session=first; Domain=.itunes.apple.com; Path=/; Secure']],
      })
      .mockResolvedValueOnce(reply(null, { 'x-apple-amd-action': 'SP', 'x-apple-amd-data': 'c3BpbQ==' }))
      .mockResolvedValueOnce({
        ...reply({ settingInfo: 'c2V0dGluZw==', transportKey: 'dHJhbnNwb3J0', keybag: Uint8Array.of(1, 2) }),
        rawHeaders: [['set-cookie', 'session=finished; Domain=.itunes.apple.com; Path=/; Secure']],
      })
      .mockResolvedValueOnce(reply({ customerMessage: 'MZFinance.BadLogin.Configurator_message' }))
      .mockResolvedValueOnce(success());

    const auth = newAuth();
    const progress = vi.fn();
    const retry = vi.fn();
    await expect(
      auth.authenticate('private@example.invalid', 'private-password', undefined, retry, progress),
    ).rejects.toMatchObject({ codeRequired: true });
    const account = await auth.authenticate('private@example.invalid', 'private-password', '123 456');
    expect(account).toMatchObject({
      passwordToken: 'private-token',
      directoryServicesIdentifier: '123456',
      store: '143470',
      storeFront: '143470-1,29',
      firstName: '',
      lastName: '',
    });
    expect(retry).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('provisioning');

    const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(requests[0].path).toBe('/auth/v1/native');
    expect(parsePlist(requests[0].body!)).toMatchObject({
      attempt: '1',
      createSession: true,
      credentialSource: 0,
      deviceOffersCheck: 'true',
      isSilentAuthentication: false,
      passwordSettings: { free: 'always', paid: 'always' },
      rmp: '0',
      why: 'signIn',
    });
    expect(requests[1].headers).not.toHaveProperty('X-Apple-AMD');
    expect(requests[1].headers).not.toHaveProperty('X-Apple-I-MD-RINFO');
    expect(requests[1].headers?.['X-Mme-Device-Id']).toBe('device-identity');
    expect(requests[2]).toMatchObject({ host: 'auth.itunes.apple.com', path: '/auth/v1/otp/1.5/finish' });
    expect(requests[2].cookies).toEqual([expect.objectContaining({ name: 'session', value: 'first' })]);
    expect(parsePlist(requests[2].body!)).toEqual({ clientData: 'Y3BpbQ==', kbsync: 'a2JzeW5j' });
    expect(parsePlist(requests[4].body!)).toMatchObject({ password: 'private-password123456', attempt: '2' });
    expect(requests[4].cookies).toEqual([expect.objectContaining({ name: 'session', value: 'finished' })]);
    expect(requests[3].headers?.['X-Apple-AMD']).not.toEqual(requests[4].headers?.['X-Apple-AMD']);
    expect(calls.map((entry) => entry.operation)).toEqual([
      'bootstrap',
      'provision-start',
      'provision-finish',
      'proof',
      'proof',
    ]);
    expect(calls[2]).toEqual({
      operation: 'provision-finish',
      deviceId: account.deviceIdentifier.toUpperCase(),
      pending: 'pending-session',
      settingInfo: 'c2V0dGluZw==',
      transportKey: 'dHJhbnNwb3J0',
      keybag: 'AQI=',
    });
    const helperTraffic = JSON.stringify(calls);
    for (const secret of [
      'private@example.invalid',
      'private-password',
      '123456',
      'private-token',
      'session=',
      'cookies',
      'appleId',
    ]) {
      expect(helperTraffic).not.toContain(secret);
    }
    const authenticationRequests = requests.filter((request) => request.path === '/auth/v1/native');
    expect(connectSAP).toHaveBeenCalledTimes(3);
    expect(signers.flatMap(({ sign }) => sign.mock.calls.map(([body]) => body))).toEqual(
      authenticationRequests.map((request) => new TextEncoder().encode(request.body)),
    );
    expect(authenticationRequests.map((request) => request.headers?.['X-Apple-ActionSignature'])).toEqual([
      'AQ==',
      'Ag==',
      'Aw==',
      'Aw==',
    ]);
  });

  it('restarts SAP and protocol flags after failed provisioning while retaining device state', async () => {
    const calls = helper('bootstrap');
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply(null, { 'x-apple-amd-action': 'SP', 'x-apple-amd-data': 'challenge' }))
      .mockResolvedValueOnce(reply(null, {}, 500))
      .mockResolvedValueOnce(reply(null, { 'x-apple-amd-action': 'SP', 'x-apple-amd-data': 'new-challenge' }))
      .mockResolvedValueOnce(reply({ settingInfo: 'setting', transportKey: 'transport' }))
      .mockResolvedValueOnce(success());
    const auth = newAuth();
    await expect(auth.authenticate('test@example.invalid', 'password')).rejects.toThrow('provisioning failed');
    await expect(auth.authenticate('test@example.invalid', 'password')).resolves.toMatchObject({
      directoryServicesIdentifier: '123456',
    });
    expect(connectSAP).toHaveBeenCalledTimes(3);
    const bootstraps = calls.filter((call) => call.operation === 'bootstrap');
    expect(bootstraps.map((call) => call.state)).toEqual([undefined, 'initial-state']);
  });

  it('retains the same session for a replacement 2FA code and generates a new proof each time', async () => {
    const calls = helper();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply({ customerMessage: 'MZFinance.BadLogin.Configurator_message' }))
      .mockResolvedValueOnce(reply({ customerMessage: 'MZFinance.BadLogin.Configurator_message' }))
      .mockResolvedValueOnce(success());
    const auth = newAuth();
    await expect(auth.authenticate('test@example.invalid', 'password')).rejects.toMatchObject({ codeRequired: true });
    await expect(auth.authenticate('test@example.invalid', 'password', '111111')).rejects.toMatchObject({
      codeRequired: true,
    });
    await expect(auth.authenticate('test@example.invalid', 'password', '222222')).resolves.toMatchObject({
      directoryServicesIdentifier: '123456',
    });
    expect(connectSAP).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.operation)).toEqual(['bootstrap', 'proof', 'proof']);
  });

  it('does not reuse a pending 2FA session after credentials change', async () => {
    const calls = helper();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        ...reply({ customerMessage: 'MZFinance.BadLogin.Configurator_message' }),
        rawHeaders: [['set-cookie', 'previous=first-user; Domain=.itunes.apple.com; Path=/; Secure']],
      })
      .mockResolvedValueOnce(success());
    const auth = newAuth();
    await expect(auth.authenticate('first@example.invalid', 'first-password')).rejects.toMatchObject({
      codeRequired: true,
    });
    await auth.authenticate('second@example.invalid', 'second-password', '123456');
    expect(connectSAP).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.operation)).toEqual(['bootstrap', 'bootstrap']);
    expect(vi.mocked(appleRequest).mock.calls[1][0].cookies).toEqual([]);
  });

  it('rejects repeated machine actions instead of entering an unbounded login loop', async () => {
    helper('bootstrap');
    vi.mocked(appleRequest).mockResolvedValue(reply(null, { 'x-apple-amd-action': 'RP' }));
    await expect(newAuth().authenticate('test@example.invalid', 'password')).rejects.toThrow('did not complete');
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    [303, '/auth/v1/native'],
    [302, 'https://example.invalid/auth/v1/native'],
    [302, 'https://auth.itunes.apple.com/unrelated'],
    [302, 'https://auth.itunes.apple.com/auth/v1/native#fragment'],
    [302, 'https://auth.itunes.apple.com/auth/v1/%6eative'],
  ])('rejects an unsupported redirect without forwarding credentials (%i, %s)', async (status, location) => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue(reply(null, { location }, status));
    await expect(newAuth().authenticate('test@example.invalid', 'password')).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves a populated credential error even with HTTP 429', async () => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue(
      reply({ failureType: 'invalid', customerMessage: 'Credentials rejected' }, {}, 429),
    );
    await expect(newAuth().authenticate('test@example.invalid', 'password')).rejects.toThrow('Credentials rejected');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([{ accountInfo: { address: {} } }, { passwordToken: 'token' }])(
    'does not store an incomplete successful-looking account',
    async (body) => {
      helper();
      vi.mocked(appleRequest).mockResolvedValue(reply(body));
      await expect(newAuth().authenticate('test@example.invalid', 'password')).rejects.toThrow(
        'missing account credentials',
      );
    },
  );

  it('falls back to a DSID cookie and does not require address/profile fields', async () => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue({
      ...reply({ passwordToken: 'token' }),
      rawHeaders: [['set-cookie', 'mz_at0-654321=opaque; Domain=.itunes.apple.com; Path=/; Secure']],
    });
    await expect(newAuth().authenticate('test@example.invalid', 'password')).resolves.toMatchObject({
      directoryServicesIdentifier: '654321',
      appleId: 'test@example.invalid',
      firstName: '',
    });
  });

  it('uses the DSID header when the plist contains an empty DSID field', async () => {
    helper();
    vi.mocked(appleRequest).mockResolvedValue(
      reply({ passwordToken: 'token', dsPersonId: '' }, { 'x-dsid': '123456' }),
    );
    await expect(newAuth().authenticate('test@example.invalid', 'password')).resolves.toMatchObject({
      directoryServicesIdentifier: '123456',
    });
  });

  it('fails before sending credentials when device verification is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'error' })),
    );
    await expect(newAuth().authenticate('test@example.invalid', 'password')).rejects.toThrow('unavailable');
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it('rejects malformed verification codes before any protocol request', async () => {
    helper();
    await expect(newAuth().authenticate('test@example.invalid', 'password', '12x456')).rejects.toThrow('six digits');
    expect(appleRequest).not.toHaveBeenCalled();
    expect(fetchBag).not.toHaveBeenCalled();
  });

  it('keeps one safe diagnostic flow across the 2FA continuation without forwarding it to Apple', async () => {
    clearDiagnosticEvents();
    helper();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply({ customerMessage: 'MZFinance.BadLogin.Configurator_message' }))
      .mockResolvedValueOnce(success());
    const flow = createDiagnosticFlow('login');
    const unrelated = createDiagnosticFlow('login');
    const guid = `aabbccdd${(++device).toString(16).padStart(4, '0')}`;
    const auth = new Authenticator(guid, [], flow);
    let waiting: unknown;
    try {
      await auth.authenticate('private@example.invalid', 'private-password');
    } catch (error) {
      waiting = error;
    }
    expect(getDiagnosticId(waiting)).toBe(flow.id);
    await auth.authenticate('private@example.invalid', 'private-password', '654321', undefined, undefined, unrelated);

    const events = getDiagnosticEvents();
    expect(events.every((event) => event.flowId === flow.id)).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'verification',
          outcome: 'transition',
          reason: 'verification_required',
          codeRequired: true,
        }),
        expect.objectContaining({ stage: 'verification', outcome: 'success', codeRequired: false }),
      ]),
    );
    for (const [, options] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(options?.headers).get('X-Asspp-Flow-Id')).toBe(flow.id);
      expect(String(options?.body ?? '')).not.toContain(flow.id);
    }
    for (const [request] of vi.mocked(appleRequest).mock.calls) {
      expect(request.diagnostics).toBe(flow);
      expect(request.headers).not.toHaveProperty('X-Asspp-Flow-Id');
    }
    const serialized = JSON.stringify(events);
    for (const secret of [
      'private@example.invalid',
      'private-password',
      'private-token',
      '654321',
      guid,
      'initial-state',
      'fresh-proof',
      'machine-proof',
      'device-identity',
      'auth.itunes.apple.com',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
