import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchEndpoint, downloadProduct } from '../../src/apple/downloadProduct';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { createDiagnosticFlow, getDiagnosticEvents, clearDiagnosticEvents } from '../../src/utils/diagnostics';
import type { AppleResponse } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

const deviceProof = vi.hoisted(() => ({ proof: vi.fn(), kbsync: vi.fn() }));
vi.mock('../../src/apple/storeProof', () => ({
  StoreProofClient: class {
    proof = deviceProof.proof;
    kbsync = deviceProof.kbsync;
  },
}));
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));

const entURL = 'https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download';
const account: Account = {
  email: 'synthetic@example.invalid',
  password: 'synthetic-password',
  appleId: '',
  store: '143441',
  storeFront: '143441-1,29',
  firstName: '',
  lastName: '',
  passwordToken: 'synthetic-token',
  directoryServicesIdentifier: '123456789',
  deviceIdentifier: '001122334455',
  cookies: [],
  pod: '25',
};
const app = { id: 1234567890, bundleID: 'invalid.example.fixture' } as Software;
const metadata = {
  itemId: app.id,
  softwareVersionBundleId: app.bundleID,
  softwareVersionExternalIdentifier: '987654321',
  softwareVersionExternalIdentifiers: ['987654320', '987654321'],
  bundleShortVersionString: '1.0',
  bundleVersion: '42',
  releaseDate: '2026-11-01',
};
function response(dict: Record<string, unknown>, status = 200): AppleResponse {
  return { status, body: buildPlist(dict), statusText: '', headers: {}, rawHeaders: [] };
}
function success(overrides: Record<string, unknown> = {}) {
  return response({
    songList: [
      {
        URL: 'https://example.invalid/app.ipa',
        metadata: { ...metadata, ...overrides },
        sinfs: [{ id: 0, sinf: 'AA==' }],
      },
    ],
  });
}
function catalog(): AppleResponse {
  return {
    ...response({}),
    body: JSON.stringify({
      results: { [app.id]: { bundleId: app.bundleID, offers: [{ version: { externalId: '987654321' } }] } },
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchBag).mockResolvedValue({
    authURL: 'https://auth.itunes.apple.com/auth/v1/native',
    downloadURL: entURL,
    redownloadURL: 'https://downloaddispatch.itunes.apple.com/r/redownload',
    updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
  });
  deviceProof.proof.mockImplementation(async () => ({
    'X-Apple-AMD': `proof-${deviceProof.proof.mock.calls.length}`,
    'X-Apple-AMD-M': 'machine',
  }));
  deviceProof.kbsync.mockResolvedValue('c3ludGhldGljLWtic3luYw==');
});

describe('native entitlement downloads', () => {
  it('matches the upstream known serial vector and sends the exact version-bound native request', async () => {
    vi.mocked(appleRequest).mockResolvedValue(success());
    await downloadProduct(account, app, '987654321');
    expect(deviceProof.kbsync).toHaveBeenCalledExactlyOnceWith('123456789');
    expect(deviceProof.proof).toHaveBeenCalledExactlyOnceWith(`${entURL}?guid=001122334455`);
    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe('downloaddispatch.itunes.apple.com');
    expect(request.path).toBe('/WebObjects/DownloadDispatch.woa/wa/ent/download?guid=001122334455');
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'X-Token': account.passwordToken,
      'X-Dsid': account.directoryServicesIdentifier,
      'iCloud-DSID': account.directoryServicesIdentifier,
      'X-Apple-Store-Front': '143441-1,29',
      'X-Apple-AMD': 'proof-1',
      'X-Apple-AMD-M': 'machine',
    });
    expect(parsePlist(request.body!)).toEqual({
      creditDisplay: '',
      guid: '001122334455',
      salableAdamId: '1234567890',
      serialNumber: 'VMiwqYgiM0RV',
      kbsync: 'c3ludGhldGljLWtic3luYw==',
      externalVersionId: '987654321',
    });
    expect(request.body).not.toContain(account.password);
    expect(deviceProof.proof.mock.calls.flat().join()).not.toContain(account.passwordToken);
  });

  it.each(['download', 'versions', 'metadata'])(
    'uses the entitlement route for %s and pins the iOS offer',
    async (operation) => {
      vi.mocked(appleRequest).mockImplementation(async (request) =>
        request.host === 'uclient-api.itunes.apple.com' ? catalog() : success(),
      );
      if (operation === 'download')
        expect((await getDownloadInfo(account, app)).output.downloadURL).toBe('https://example.invalid/app.ipa');
      if (operation === 'versions')
        expect((await listVersions(account, app)).versions).toEqual(['987654321', '987654320']);
      if (operation === 'metadata')
        expect((await getVersionMetadata(account, app, '987654321')).metadata.displayVersion).toBe('1.0');
      const request = vi.mocked(appleRequest).mock.calls.at(-1)![0];
      expect(parsePlist(request.body!)).toMatchObject({ externalVersionId: '987654321' });
      expect(request.path).toContain('/ent/download');
      if (operation !== 'metadata') {
        const lookup = vi.mocked(appleRequest).mock.calls[0][0];
        expect(lookup.cookies).toBeUndefined();
        expect(lookup.headers).toBeUndefined();
      }
    },
  );

  it('does not replace a historical version with the catalog latest version', async () => {
    vi.mocked(appleRequest).mockResolvedValue(success({ softwareVersionExternalIdentifier: '987654320' }));
    await downloadProduct(account, app, '987654320');
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[0][0].body!)).toMatchObject({
      externalVersionId: '987654320',
    });
  });

  it('preserves cookies and obtains a new proof for each endpoint in the bounded fallback chain', async () => {
    clearDiagnosticEvents();
    const flow = createDiagnosticFlow('download');
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        ...response({}),
        rawHeaders: [['set-cookie', 'testSession=continued; Domain=.itunes.apple.com; Path=/; Secure']],
      })
      .mockResolvedValueOnce(response({ failureType: '5002' }))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(success());
    await downloadProduct(account, app, '987654321', flow);
    const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.headers?.['X-Apple-AMD'])).toEqual([
      'proof-1',
      'proof-2',
      'proof-3',
      'proof-4',
    ]);
    expect(deviceProof.proof.mock.calls.map(([url]) => url)).toEqual(
      requests.map((request) => `https://${request.host}${request.path}`),
    );
    expect(requests.slice(1).every((request) => request.cookies?.some((cookie) => cookie.value === 'continued'))).toBe(
      true,
    );
    expect(requests.every((request) => request.headers?.['X-Apple-Store-Front'] === '143441-1,29')).toBe(true);
    expect(parsePlist(requests[1].body!).externalVersionId).toBe('987654321');
    expect(parsePlist(requests[2].body!).appExtVrsId).toBe('987654321');
    expect(fetchBag).toHaveBeenCalledOnce();
    expect(requests.every((request) => request.diagnostics === flow)).toBe(true);
    const events = getDiagnosticEvents().filter((event) => event.flowId === flow.id);
    expect(
      events
        .filter((event) => event.stage === 'download_product' && event.outcome === 'retry')
        .map((event) => event.endpoint),
    ).toEqual(['volume_download', 'redownload', 'update']);
    const serialized = JSON.stringify(events);
    for (const secret of [
      account.email,
      account.password,
      account.passwordToken,
      account.deviceIdentifier,
      account.directoryServicesIdentifier,
      app.bundleID,
      'proof-1',
      'testSession',
      'continued',
      '987654321',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([204, 404, 500, 503])(
    'recovers an empty entitlement HTTP %s response through the legacy route',
    async (status) => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({ ...response({}, status), body: '' })
        .mockResolvedValueOnce(success());
      await downloadProduct(account, app, '987654321');
      expect(appleRequest).toHaveBeenCalledTimes(2);
      expect(vi.mocked(appleRequest).mock.calls[1][0].path).toContain('volumeStoreDownloadProduct');
    },
  );

  it.each([
    { failureType: '9610' },
    { failureType: '2034' },
    { failureType: '2042' },
    { metrics: { messageCode: '1008' } },
    { customerMessage: 'Sign In to the iTunes Store' },
    { customerMessage: 'Account is disabled' },
  ])('preserves the actionable entitlement error %j without fallback', async (dict) => {
    vi.mocked(appleRequest).mockResolvedValue(response(dict));
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it("preserves the license-required code in Apple's redownload dialog", async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      response({
        dialog: {
          message: 'Redownload Unavailable with This Apple Account',
          explanation:
            'This redownload is not available for this Apple Account either because it was bought by a different user or the item was refunded or cancelled.',
        },
      }),
    );
    await expect(downloadProduct(account, app, '987654321')).rejects.toMatchObject({ code: '9610' });
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('does not accept package metadata accompanied by a customer error', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      response({
        ...parsePlist(success().body),
        customerMessage: 'Account is disabled',
      }),
    );
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow('Account is disabled');
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 1 },
    { status: 'failed' },
    { dialog: { message: 'Account needs review' } },
    { action: { kind: 'Goto', url: 'https://example.invalid/private-action' } },
  ])('does not treat metadata accompanied by an explicit rejection as success: %j', async (failure) => {
    vi.mocked(appleRequest).mockResolvedValue(response({ ...parsePlist(success().body), ...failure }));
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it.each([{ itemId: '2' }, { softwareVersionExternalIdentifier: '2' }, { softwareVersionBundleId: 'wrong.app' }])(
    'rejects wrong app/version/bundle metadata %j without trying another route',
    async (mismatch) => {
      vi.mocked(appleRequest).mockResolvedValue(success(mismatch));
      await expect(downloadProduct(account, app, '987654321')).rejects.toThrow();
      expect(appleRequest).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 403])('does not hide entitlement HTTP %s as availability failure', async (status) => {
    vi.mocked(appleRequest).mockResolvedValue({ ...response({}, status), body: '' });
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow(`HTTP ${status}`);
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('does not send a request without a valid device proof', async () => {
    deviceProof.proof.mockRejectedValue(new Error('Re-authentication required'));
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow('Re-authentication');
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it('does not forward tokens, cookies or proofs to an entitlement redirect', async () => {
    vi.mocked(appleRequest).mockResolvedValue({
      ...response({}, 302),
      headers: { location: 'https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122334455' },
    });
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow('redirected');
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(deviceProof.proof).toHaveBeenCalledOnce();
  });

  it('surfaces a repeated machine-provisioning action as a reauthentication requirement', async () => {
    vi.mocked(appleRequest).mockResolvedValue({ ...response({}, 204), headers: { 'x-apple-amd-action': 'SP' } });
    await expect(downloadProduct(account, app, '987654321')).rejects.toMatchObject({ code: '2034' });
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it.each([
    entURL + '?',
    entURL + '#',
    entURL + '?guid=other',
    entURL.replace('/wa/ent', '/wa/%65nt'),
    entURL.replace('https:', 'http:'),
    entURL.replace('.apple.com', '.apple.com.example.invalid'),
    entURL.replace('https://', 'https://user@'),
  ])('rejects malformed/untrusted bag endpoints before requesting a proof: %s', async (downloadURL) => {
    expect(dispatchEndpoint(downloadURL, 'ent', account.deviceIdentifier)).toBeUndefined();
    vi.mocked(fetchBag).mockResolvedValue({ authURL: '', downloadURL });
    await expect(downloadProduct(account, app, '987654321')).rejects.toThrow('endpoint');
    expect(deviceProof.proof).not.toHaveBeenCalled();
    expect(deviceProof.kbsync).not.toHaveBeenCalled();
    expect(appleRequest).not.toHaveBeenCalled();
  });
});
