// The HTTP side of the OpenAI-style /chat/completions adapters (OpenAI,
// OpenCode, OpenRouter). With stream:false nothing — not even headers — arrives
// until the model has finished, and a reasoning model over a long transcript
// can take minutes, so requests go through a client whose header/body
// timeouts match the adapter's own deadline (Node's fetch stops at 300s).
import { fetchWithTimeouts, withTimeoutMessage } from '../http.js';
import { httpError, withRetry } from './errors.js';

export const CHAT_TIMEOUT_MS = 600_000;

/** The fetch an adapter uses: an injected one (tests) or a timeout-aware default. */
export function chatFetch(fetchImpl, timeoutMs = CHAT_TIMEOUT_MS) {
  return fetchImpl ?? fetchWithTimeouts(timeoutMs);
}

/** POST a chat completion and return its JSON. Retries 5xx, never a timeout. */
export function postChatCompletion({ fetchImpl, url, headers, payload, provider, timeoutMs = CHAT_TIMEOUT_MS }) {
  return withTimeoutMessage(() => withRetry(async () => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''));
    return res.json();
  }), provider, timeoutMs);
}
