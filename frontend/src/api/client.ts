import { getAccessToken } from '../components/Auth/PasswordGate';

const BASE_URL = '';

export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { 'X-Access-Token': token } : {};
}

async function apiRequest<T>(path: string, options: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let receivedResponse = false;
  try {
    const response = await fetch(BASE_URL + path, { ...options, signal: controller.signal });
    receivedResponse = true;
    if (!response.ok) {
      const error = new Error(await response.text());
      Object.assign(error, { diagnostics: { httpStatus: response.status, reason: 'http_error' } });
      throw error;
    }
    return await read(response);
  } catch (error) {
    if (controller.signal.aborted) {
      const timedOut = new Error('The server request timed out.');
      timedOut.name = 'TimeoutError';
      Object.assign(timedOut, { diagnostics: { reason: 'timeout' } });
      throw timedOut;
    }
    if (error instanceof Error && !('diagnostics' in error)) {
      Object.assign(error, { diagnostics: { reason: receivedResponse ? 'invalid_response' : 'network' } });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiGet<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  return apiRequest(path, { headers: { ...headers, ...authHeaders() } }, (response) => response.json());
}

export async function apiPost<T>(path: string, body?: any, headers: Record<string, string> = {}): Promise<T> {
  return apiRequest(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    },
    (response) => response.json(),
  );
}

export async function apiDelete(path: string, headers: Record<string, string> = {}): Promise<void> {
  return apiRequest(path, { method: 'DELETE', headers: { ...headers, ...authHeaders() } }, async () => undefined);
}
