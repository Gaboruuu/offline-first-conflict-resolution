import { logDebug } from '@/util/log';
import { NetworkError, ServerError } from './errors';

export const DEFAULT_TIMEOUT_MS = 6000;

export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * One JSON request with a timeout. A request that never reaches the server rejects with
 * [NetworkError], an error status with [ServerError] (code, message and fields from the JSON body).
 */
export async function requestJson(options: HttpOptions, method: string, path: string, body?: unknown): Promise<unknown> {
  const { baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = (...args) => fetch(...args), headers = {} } = options;
  const url = `${baseUrl}${path}`;
  const started = Date.now();
  logDebug('HTTP', `${method} ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : String(error);
    logDebug('HTTP', `${method} ${url} failed: ${reason}`);
    throw new NetworkError(`${method} ${path}: ${reason}`, error);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  logDebug('HTTP', `${method} ${url} → ${response.status} (${Date.now() - started} ms)`);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new ServerError(response.status, 'BAD_RESPONSE', `Response is not JSON: ${text.slice(0, 100)}`);
  }
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } })?.error;
    throw new ServerError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? `${method} ${path} failed with HTTP ${response.status}`,
      error?.fields,
    );
  }
  return json;
}
