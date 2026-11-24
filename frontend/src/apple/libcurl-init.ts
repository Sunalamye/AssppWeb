import { libcurl } from 'libcurl.js/bundled';
import { getAccessToken } from '../components/Auth/PasswordGate';
import { createDiagnosticFlow, errorDiagnosticDetails } from '../utils/diagnostics';
import type { DiagnosticFlow } from '../utils/diagnostics';

let initialized = false;
let initPromise: Promise<void> | null = null;
let proxyURL: string | undefined;

function configureProxy(flow?: DiagnosticFlow): void {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${wsProto}//${location.host}/wisp/`;
  const token = getAccessToken();
  if (token) wsUrl += `?token=${encodeURIComponent(token)}`;
  if (proxyURL === wsUrl) return;
  libcurl.set_websocket(wsUrl);
  proxyURL = wsUrl;
  flow?.log('transport', 'transition', { endpoint: 'wisp' });
}

export async function initLibcurl(diagnostics?: DiagnosticFlow): Promise<void> {
  if (initialized) {
    configureProxy(diagnostics);
    return;
  }
  if (!initPromise) {
    const flow = diagnostics ?? createDiagnosticFlow('login');
    const started = Date.now();
    flow.log('transport', 'start', { endpoint: 'wasm' });
    initPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        configureProxy(flow);
        await Promise.race([
          libcurl.load_wasm(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DOMException('Connection runtime initialization timed out', 'TimeoutError')),
              15_000,
            );
          }),
        ]);
        initialized = true;
        flow.log('transport', 'success', { endpoint: 'wasm', durationMs: Date.now() - started });
      } catch (error) {
        flow.log('transport', 'failure', {
          ...errorDiagnosticDetails(error),
          endpoint: 'wasm',
          durationMs: Date.now() - started,
        });
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })().catch((error) => {
      // A rejected singleton must not poison every later attempt until page reload.
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
  // Access-password renewal can happen while the WASM module is loading.
  configureProxy(diagnostics);
}

export { libcurl };
