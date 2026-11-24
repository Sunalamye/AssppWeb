/** Response decisions after AMD provisioning and approved redirects are handled. */
export interface AuthResponseFacts {
  validShape: boolean;
  dialogPresent: boolean;
  actionPresent: boolean;
  rejectedStatus: boolean;
  failure: 'none' | 'retryCredentials' | 'other';
  message: 'none' | 'verification' | 'disabled' | 'other';
  firstAttempt: boolean;
  httpOk: boolean;
  hasToken: boolean;
  hasDsid: boolean;
}

export type AuthResponseDecision = 'reject' | 'retry_credentials' | 'verification' | 'authenticated';

export function decideAuthResponse(facts: AuthResponseFacts): AuthResponseDecision {
  if (!facts.validShape || facts.dialogPresent || facts.actionPresent || facts.rejectedStatus) return 'reject';
  if (facts.failure === 'retryCredentials' && facts.firstAttempt) return 'retry_credentials';
  if (facts.failure !== 'none') return 'reject';
  if (facts.message === 'verification') return 'verification';
  if (facts.message === 'disabled') return 'reject';
  return facts.httpOk && facts.hasToken && facts.hasDsid ? 'authenticated' : 'reject';
}
