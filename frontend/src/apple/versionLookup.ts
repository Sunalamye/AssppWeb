import { downloadProduct } from './downloadProduct';
import { createDiagnosticFlow, errorDiagnosticDetails, attachDiagnosticId } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { Account, Software, VersionMetadata } from '../types';

export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
  flow: DiagnosticFlow = createDiagnosticFlow('versions'),
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: typeof account.cookies;
}> {
  const started = Date.now();
  flow.log('version_lookup', 'start');
  try {
    const { dict, updatedCookies } = await downloadProduct(account, app, versionId, flow);
    const metadata = dict.songList[0].metadata;
    if (!metadata?.bundleShortVersionString) throw new Error('Missing bundleShortVersionString');
    if (!metadata.releaseDate) throw new Error('Missing releaseDate');
    const result = {
      metadata: {
        displayVersion: metadata.bundleShortVersionString,
        releaseDate:
          metadata.releaseDate instanceof Date ? metadata.releaseDate.toISOString() : String(metadata.releaseDate),
      },
      updatedCookies,
    };
    flow.log('version_lookup', 'success', { durationMs: Date.now() - started });
    return result;
  } catch (error) {
    flow.log('version_lookup', 'failure', { ...errorDiagnosticDetails(error), durationMs: Date.now() - started });
    throw attachDiagnosticId(error, flow.id);
  }
}
