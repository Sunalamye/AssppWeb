import { authHeaders } from '../api/client';
import type { DiagnosticEvent } from './diagnostics';

// A failed logging request never retries the business action or blocks its UI.
const queue: DiagnosticEvent[] = [];
const queueLimit = 200;
const parallelLimit = 2;
let active = 0;

async function send(event: DiagnosticEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(event),
      signal: controller.signal,
      keepalive: true,
    });
  } catch {
    // The safe, bounded local history remains available from Settings for export.
  } finally {
    clearTimeout(timeout);
  }
}

function drain(): void {
  while (active < parallelLimit && queue.length) {
    const event = queue.shift()!;
    active++;
    void send(event).finally(() => {
      active--;
      drain();
    });
  }
}

export function enqueueDiagnosticEvent(event: DiagnosticEvent): void {
  if (queue.length === queueLimit) queue.shift();
  queue.push(event);
  drain();
}
