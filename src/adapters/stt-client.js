import { basename } from 'node:path';
import { config } from '../config/env.js';
import { errorBodySnippet, fetchWithTimeouts, fileBlob, isTimeoutError } from './http.js';

// Generous: one call transcribes a whole speaking turn, which on CPU can take
// minutes for the larger models. This only fires on a stalled (silent) sidecar;
// a dead one fails fast with ECONNREFUSED. Tunable via deps.timeoutMs.
const DEFAULT_TIMEOUT_MS = 600_000;

async function postTrack(url, file, filePath, opts, { fetchImpl, timeoutMs }) {
  const form = new FormData();
  form.append('file', file, basename(filePath));
  form.append('model', opts.model || 'small');
  form.append('language', opts.language || 'auto');
  if (opts.vocabulary) form.append('vocabulary', opts.vocabulary);
  const res = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok) return res.json();
  // Always consume the body so the connection is released, and keep the
  // sidecar's reason (e.g. {"detail":"Unsupported model"}) for the user.
  const detail = await errorBodySnippet(res);
  const err = new Error(`STT sidecar HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  err.status = res.status;
  // 4xx is a client error (bad request/model/payload) — retrying re-uploads
  // the whole file to fail again. Only retry 5xx / network errors.
  if (res.status >= 400 && res.status < 500) err.noRetry = true;
  throw err;
}

export async function transcribeFile(filePath, opts = {}, deps = {}) {
  const baseUrl = deps.baseUrl || config.sttUrl;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl || fetchWithTimeouts(timeoutMs);
  const retries = deps.retries ?? 1;
  const backoffMs = deps.backoffMs ?? 500;
  const file = await fileBlob(filePath, deps);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await postTrack(`${baseUrl}/transcribe`, file, filePath, opts, { fetchImpl, timeoutMs });
    } catch (err) {
      // A timed-out sidecar is usually still transcribing the first upload;
      // sending it again only doubles the work. Give up with a clear reason.
      if (isTimeoutError(err)) {
        throw new Error(`STT sidecar timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
      }
      lastErr = err;
      if (err?.noRetry) break; // don't burn retries on a permanent client error
      // Back off before retrying a transient failure (stalled/booting sidecar).
      if (attempt < retries && backoffMs > 0) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}
