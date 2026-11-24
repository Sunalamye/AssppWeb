import { useRef } from 'react';
import { createDiagnosticFlow } from '../utils/diagnostics';
import type { DiagnosticEvent } from '../utils/diagnostics';

/** React's disabled state renders later; this guard closes the same-tick click race. */
export function useActionGuard() {
  const busy = useRef(false);
  return {
    begin(kind: DiagnosticEvent['flow']) {
      if (busy.current) {
        createDiagnosticFlow(kind).log('action', 'blocked', { reason: 'busy' });
        return false;
      }
      busy.current = true;
      return true;
    },
    end() {
      busy.current = false;
    },
  };
}
