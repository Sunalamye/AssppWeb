import { getDiagnosticId } from './diagnostics';

export function getErrorMessage(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : fallback;
  const id = getDiagnosticId(e);
  return id ? `${message}\n[flow: ${id}]` : message;
}
