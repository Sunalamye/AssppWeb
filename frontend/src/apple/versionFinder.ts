import { downloadProduct } from './downloadProduct';
import { createDiagnosticFlow, errorDiagnosticDetails, attachDiagnosticId } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';
import type { Account, Software } from '../types';

export async function listVersions(
  account: Account,
  app: Software,
  flow: DiagnosticFlow = createDiagnosticFlow('versions'),
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  const started = Date.now();
  flow.log('version_lookup', 'start');
  try {
    const { dict, updatedCookies } = await downloadProduct(account, app, undefined, flow);
    const identifiers = dict.songList[0].metadata?.softwareVersionExternalIdentifiers;
    if (!Array.isArray(identifiers)) throw new Error('Missing version identifiers');
    if (
      identifiers.some(
        (value) =>
          (typeof value !== 'string' && typeof value !== 'number') ||
          (typeof value === 'number' && !Number.isSafeInteger(value)) ||
          !/^[1-9]\d*$/.test(String(value)),
      )
    ) {
      throw new Error('Invalid version identifiers');
    }
    const versions = identifiers.map(String).reverse();
    if (!versions.length) throw new Error('No versions found');
    flow.log('version_lookup', 'success', { durationMs: Date.now() - started });
    return { versions, updatedCookies };
  } catch (error) {
    flow.log('version_lookup', 'failure', { ...errorDiagnosticDetails(error), durationMs: Date.now() - started });
    throw attachDiagnosticId(error, flow.id);
  }
}
