/** Finite response abstraction checked against the executable Lean specification. */
export interface DownloadResponseFacts {
  validShape: boolean;
  dialogPresent: boolean;
  actionPresent: boolean;
  status: 'missing' | 'zero' | 'rejected';
  itemsPresent: boolean;
  failure: 'none' | 'unavailable' | 'other';
  message: 'none' | 'unavailable' | 'generic' | 'other';
}

export type DownloadResponseDecision = 'items' | 'fallback' | 'reject';

export function decideDownloadResponse(facts: DownloadResponseFacts): DownloadResponseDecision {
  if (
    !facts.validShape ||
    facts.dialogPresent ||
    facts.actionPresent ||
    facts.status === 'rejected' ||
    facts.failure === 'other' ||
    facts.message === 'other'
  ) {
    return 'reject';
  }
  if (facts.itemsPresent) {
    return facts.failure === 'none' && facts.message === 'none' ? 'items' : 'reject';
  }
  if (facts.failure === 'unavailable') return 'fallback';
  if (facts.message === 'generic') return 'reject';
  return 'fallback';
}
