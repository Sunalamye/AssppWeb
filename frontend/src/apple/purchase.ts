import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import {
  attachDiagnosticId,
  createDiagnosticFlow,
  errorDiagnosticDetails,
  safeDiagnosticDetails,
  validAppleDialogCode,
} from '../utils/diagnostics';
import { purchaseAPIHost } from './config';
import type { AppleResponse } from './request';
import type { DiagnosticDetails, DiagnosticFlow } from '../utils/diagnostics';
import type { Account, Software } from '../types';

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly diagnostics?: DiagnosticDetails,
  ) {
    super(message);
    this.name = 'PurchaseError';
  }
}

export interface PurchaseResult {
  updatedCookies: Account['cookies'];
  /** Apple reported the account already holds this license (failureType 5002). */
  alreadyOwned: boolean;
}

type PurchaseDictionary = Record<string, unknown>;

function dictionary(value: unknown): value is PurchaseDictionary {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function failureCode(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return text(value);
}

function failureTypeKind(value: unknown): DiagnosticDetails['failureTypeKind'] {
  if (value === undefined) return 'missing';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'numeric' : 'invalid';
  if (typeof value !== 'string') return 'invalid';
  const code = value.trim();
  if (!code) return 'empty';
  return /^-?\d+$/.test(code) ? 'numeric' : 'text';
}

function statusKind(value: unknown): DiagnosticDetails['statusKind'] {
  if (value === undefined) return 'missing';
  if (typeof value === 'string') return 'text';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid';
  return value === 0 ? 'zero' : 'nonzero';
}

function dialogKind(value: unknown): DiagnosticDetails['dialogKind'] {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return 'missing';
  const kind = text(value);
  switch (kind) {
    case 'authorization':
    case 'confirmation':
    case 'acknowledgement':
    case 'error':
      return kind;
    default:
      return 'other';
  }
}

function actionKind(value: unknown): DiagnosticDetails['actionKind'] {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return 'missing';
  const kind = text(value);
  switch (kind) {
    case 'Goto':
    case 'Buy':
    case 'Download':
    case 'SignIn':
      return kind;
    default:
      return 'other';
  }
}

function responseDetails(response: AppleResponse, dict: PurchaseDictionary = {}): DiagnosticDetails {
  const metrics = dictionary(dict.metrics) ? dict.metrics : {};
  const document = text(dict.jingleDocType);
  const dialogCode = metrics.dialogId;
  const classifiedDialogCode = text(dialogCode);
  const dialog = dictionary(dict.dialog) ? dict.dialog : {};
  const action = dictionary(dict.action) ? dict.action : {};
  return safeDiagnosticDetails({
    endpoint: 'purchase',
    httpStatus: response.status,
    errorCode: failureCode(dict.failureType),
    failureTypeKind: failureTypeKind(dict.failureType),
    statusKind: statusKind(dict.status),
    dialogPresent: Object.prototype.hasOwnProperty.call(dict, 'dialog'),
    actionPresent: Object.prototype.hasOwnProperty.call(dict, 'action'),
    messagePresent: !!(text(dialog.explanation) || text(dialog.message) || text(dict.customerMessage)),
    dialogKind: dialogKind(dialog.kind),
    actionKind: actionKind(action.kind),
    ...(validAppleDialogCode(dialogCode) ? { dialogCode } : {}),
    responseType:
      document === 'purchaseSuccess' || document === 'buyProductFailure' ? document : document ? 'other' : 'missing',
    dialog: ['MZCommerce.CountryMismatch', 'MZCommerce.ExpiredPasswordToken', 'MZCommerce.SystemError'].includes(
      classifiedDialogCode,
    )
      ? (classifiedDialogCode as DiagnosticDetails['dialog'])
      : classifiedDialogCode
        ? 'other'
        : 'missing',
  });
}

function purchaseFailure(message: string, details: DiagnosticDetails, code?: string): PurchaseError {
  const facts = [`HTTP ${details.httpStatus ?? 0}`];
  if (details.errorCode) facts.push(`code=${details.errorCode}`);
  if (details.responseType) facts.push(`response=${details.responseType}`);
  if (validAppleDialogCode(details.dialogCode)) facts.push(`dialog=${details.dialogCode}`);
  else if (details.dialog && details.dialog !== 'missing') facts.push(`dialog=${details.dialog}`);
  if (details.purchaseBranch) facts.push(`branch=${details.purchaseBranch}`);
  if (details.statusKind) facts.push(`status=${details.statusKind}`);
  return new PurchaseError(`${message} [${facts.join('; ')}]`, code, details);
}

function parseResponse(response: AppleResponse): PurchaseDictionary {
  let dict: PurchaseDictionary | undefined;
  try {
    const parsed: unknown = parsePlist(response.body);
    if (dictionary(parsed)) dict = parsed;
  } catch {
    /* Do not include the raw response or parser error in diagnostics. */
  }
  if (response.status !== 200) {
    throw purchaseFailure(i18n.t('errors.purchase.httpFailure', { status: response.status }), {
      ...responseDetails(response, dict),
      reason: response.status >= 300 && response.status < 400 ? 'redirect' : 'http_error',
      purchaseBranch: 'http_error',
    });
  }
  if (dict) return dict;
  throw purchaseFailure(i18n.t('errors.purchase.invalidResponse', { status: response.status }), {
    ...responseDetails(response),
    reason: response.body.trim() ? 'invalid_plist' : 'empty_response',
    purchaseBranch: 'invalid_plist',
  });
}

function requiresTerms(dict: PurchaseDictionary): boolean {
  if (dict.jingleDocType !== 'buyProductFailure' || !dictionary(dict.action) || dict.action.kind !== 'Goto')
    return false;
  const raw = text(dict.action.url ?? dict.action.URL);
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !raw.includes('#') &&
      !url.pathname.includes('%') &&
      url.pathname === '/WebObjects/MZFinance.woa/wa/com.apple.jingle.app.finance.DirectAction/termsPage'
    );
  } catch {
    return false;
  }
}

function interpretResponse(
  response: AppleResponse,
  dict: PurchaseDictionary,
  cookies: Account['cookies'],
): PurchaseResult {
  const details = responseDetails(response, dict);
  const code = failureCode(dict.failureType);
  const customerMessage = text(dict.customerMessage);
  const dialog = dictionary(dict.dialog) ? dict.dialog : {};
  const message = text(dialog.explanation) || text(dialog.message) || customerMessage;
  const fail = (
    label: string,
    reason: DiagnosticDetails['reason'],
    purchaseBranch: DiagnosticDetails['purchaseBranch'],
    errorCode = code || undefined,
  ): never => {
    throw purchaseFailure(label, { ...details, reason, purchaseBranch }, errorCode);
  };

  if (
    dict.failureType !== undefined &&
    typeof dict.failureType !== 'string' &&
    !(typeof dict.failureType === 'number' && Number.isSafeInteger(dict.failureType))
  ) {
    fail(
      i18n.t('errors.purchase.invalidResponse', { status: response.status }),
      'unexpected_response',
      'invalid_failure_type',
    );
  }
  if (dict.customerMessage !== undefined && typeof dict.customerMessage !== 'string') {
    fail(
      i18n.t('errors.purchase.invalidResponse', { status: response.status }),
      'unexpected_response',
      'invalid_customer_message',
    );
  }

  // Apple can request terms or show a dialog without a failureType. These are
  // transitions requiring user action, never proof that a license was granted.
  if (requiresTerms(dict)) fail(i18n.t('errors.purchase.termsRequiredOnDevice'), 'terms_required', 'terms_required');
  if (code === '1008')
    fail(i18n.t('errors.purchase.deviceVerificationFailed'), 'device_verification', 'device_verification');
  if (
    ['2034', '2042'].includes(code) ||
    customerMessage === 'Your password has changed.' ||
    details.dialog === 'MZCommerce.ExpiredPasswordToken'
  ) {
    fail(i18n.t('errors.purchase.passwordExpired'), 'token_expired', 'token_expired', code || '2034');
  }
  if (customerMessage === 'Subscription Required')
    fail(i18n.t('errors.purchase.subscriptionRequired'), 'subscription_required', 'subscription_required');

  // A contradictory dialog/action/status cannot be reclassified as success or
  // an automatic retry, even if it is accompanied by a familiar numeric code.
  if (dict.dialog !== undefined) {
    fail(message || i18n.t('errors.purchase.failedGeneral'), 'unexpected_response', 'dialog_present');
  }
  if (dict.action !== undefined) {
    fail(message || i18n.t('errors.purchase.failedGeneral'), 'unexpected_response', 'action_present');
  }
  if (dict.status !== undefined && dict.status !== 0) {
    fail(message || i18n.t('errors.purchase.failedGeneral'), 'unexpected_response', 'invalid_status');
  }
  if (code === '2059') fail(i18n.t('errors.purchase.unavailable'), 'unavailable', 'unavailable');
  if (code === '5002') {
    if (
      customerMessage &&
      !['An unknown error has occurred', 'An unknown error has occurred.'].includes(customerMessage)
    ) {
      fail(customerMessage, 'unexpected_response', 'conflicting_message');
    }
    return { updatedCookies: cookies, alreadyOwned: true };
  }
  if (code || customerMessage) {
    const generic =
      customerMessage === 'An unknown error has occurred' || customerMessage === 'An unknown error has occurred.';
    fail(
      generic
        ? i18n.t('errors.purchase.unknownError')
        : customerMessage || i18n.t('errors.purchase.failed', { failureType: code }),
      'unexpected_response',
      code ? 'failure_code' : 'customer_message',
    );
  }
  if (dict.jingleDocType !== 'purchaseSuccess') {
    fail(i18n.t('errors.purchase.failedGeneral'), 'unexpected_response', 'missing_success_document');
  }
  if (dict.status !== 0) {
    fail(i18n.t('errors.purchase.failedGeneral'), 'unexpected_response', 'missing_success_status');
  }
  return { updatedCookies: cookies, alreadyOwned: false };
}

export async function purchaseApp(
  account: Account,
  app: Software,
  diagnostics?: DiagnosticFlow,
): Promise<PurchaseResult> {
  const flow = diagnostics ?? createDiagnosticFlow('license');
  const started = Date.now();
  let attempt = 0;
  flow.log('purchase', 'start', { endpoint: 'purchase' });
  try {
    if ((app.price ?? 0) > 0) {
      throw new PurchaseError(i18n.t('errors.purchase.paidNotSupported'), undefined, { reason: 'paid_app' });
    }
    let cookies = [...account.cookies];
    for (const pricingParameters of ['STDQ', 'GAME']) {
      attempt++;
      const response = await appleRequest({
        method: 'POST',
        host: purchaseAPIHost(account.pod),
        path: '/WebObjects/MZFinance.woa/wa/buyProduct',
        headers: {
          'Content-Type': 'application/x-apple-plist',
          'iCloud-DSID': account.directoryServicesIdentifier,
          'X-Dsid': account.directoryServicesIdentifier,
          'X-Apple-Store-Front':
            account.storeFront || (account.store.includes('-') ? account.store : `${account.store}-1`),
          'X-Token': account.passwordToken,
        },
        body: buildPlist({
          appExtVrsId: '0',
          hasAskedToFulfillPreorder: 'true',
          buyWithoutAuthorization: 'true',
          hasDoneAgeCheck: 'true',
          guid: account.deviceIdentifier,
          needDiv: '0',
          origPage: `Software-${app.id}`,
          origPageLocation: 'Buy',
          price: '0',
          pricingParameters,
          productType: 'C',
          salableAdamId: app.id,
        }),
        cookies,
        diagnostics: flow,
      });
      cookies = extractAndMergeCookies(response.rawHeaders, cookies);
      const dict = parseResponse(response);
      flow.log('purchase', 'transition', { ...responseDetails(response, dict), attempt });
      try {
        const result = interpretResponse(response, dict, cookies);
        flow.log('purchase', 'success', {
          ...responseDetails(response, dict),
          attempt,
          alreadyOwned: result.alreadyOwned,
          purchaseBranch: result.alreadyOwned ? 'already_owned' : 'success',
          durationMs: Date.now() - started,
        });
        return result;
      } catch (error) {
        if (
          error instanceof PurchaseError &&
          error.code === '2059' &&
          error.diagnostics?.reason === 'unavailable' &&
          pricingParameters === 'STDQ'
        ) {
          flow.log('purchase', 'retry', { ...errorDiagnosticDetails(error), attempt: 2 });
          continue;
        }
        throw error;
      }
    }
    throw new PurchaseError(i18n.t('errors.purchase.failedGeneral'));
  } catch (error) {
    flow.log('purchase', 'failure', {
      ...errorDiagnosticDetails(error),
      endpoint: 'purchase',
      attempt,
      durationMs: Date.now() - started,
    });
    throw attachDiagnosticId(error, flow.id);
  }
}
