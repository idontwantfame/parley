import { basename } from 'node:path';
import { config } from '../config/env.js';
import { errorBodySnippet, fetchWithTimeouts, fileBlob, isTimeoutError } from './http.js';

// Generous: one call transcribes a whole speaking turn, which on CPU can take
// minutes for the larger models. This only fires on a stalled (silent) sidecar;
// a dead one fails fast with ECONNREFUSED. Tunable via deps.timeoutMs.
const DEFAULT_TIMEOUT_MS = 600_000;

// Speaker detection (diarization) fields. Left out entirely unless the caller
// decides (Discord tracks are one speaker each), so those requests look exactly
// as before; imports say true or false explicitly.
function appendDiarization(form, opts) {
  if (opts.diarize === undefined) return;
  form.append('diarize', opts.diarize ? 'true' : 'false');
  if (!opts.diarize) return;
  if (opts.minSpeakers != null) form.append('min_speakers', String(opts.minSpeakers));
  if (opts.maxSpeakers != null) form.append('max_speakers', String(opts.maxSpeakers));
}

// FastAPI errors arrive as {"detail": "..."}; quote just the detail.
export function sidecarErrorDetail(body) {
  try {
    const { detail } = JSON.parse(body);
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch { /* not JSON: quote the body as is */ }
  return body;
}

const ERROR_DETAIL_MAX = 300;

async function postTrack(url, file, filePath, opts, { fetchImpl, timeoutMs }) {
  const form = new FormData();
  form.append('file', file, basename(filePath));
  form.append('model', opts.model || 'small');
  form.append('language', opts.language || 'auto');
  if (opts.vocabulary) form.append('vocabulary', opts.vocabulary);
  appendDiarization(form, opts);
  const res = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok) return res.json();
  // Always consume the body so the connection is released, and keep the
  // sidecar's reason (e.g. {"detail":"Unsupported model"}) for the user.
  const detail = sidecarErrorDetail(await errorBodySnippet(res, 1000)).slice(0, ERROR_DETAIL_MAX);
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

export const OUTDATED_SIDECAR_REASON = "This sidecar version doesn't support speaker detection; update it to the -full image.";
const HEALTH_TIMEOUT_MS = 5_000;

const unavailable = (reason) => ({ available: false, speakerDetection: false, reason });

function capabilityFromHealth(body) {
  const diarization = body?.diarization;
  if (!diarization || typeof diarization !== 'object') {
    return { available: true, speakerDetection: false, reason: OUTDATED_SIDECAR_REASON };
  }
  if (diarization.available === true) return { available: true, speakerDetection: true, reason: null };
  const reason = typeof diarization.reason === 'string' && diarization.reason.trim()
    ? diarization.reason.trim() : 'Speaker detection is not enabled on this sidecar.';
  return { available: true, speakerDetection: false, reason };
}

/**
 * What the local sidecar can do for an imported recording, from GET /health
 * (short timeout): `available` = it answers, so imports can run at all;
 * `speakerDetection` = it can tell speakers apart. `reason` says why either is
 * off, in words the dashboard can show as is. Never throws.
 */
export async function sidecarCapability({ baseUrl = config.sttUrl, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = isTimeoutError(err) ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : 'connection failed';
    return unavailable(`The local speech-to-text sidecar is not reachable (${why}). Start it and try again.`);
  }
  if (!res.ok) {
    await errorBodySnippet(res);
    return unavailable(`The local speech-to-text sidecar answered HTTP ${res.status}. Check its logs and try again.`);
  }
  try {
    return capabilityFromHealth(await res.json());
  } catch {
    return unavailable('The local speech-to-text sidecar sent an unreadable health report.');
  }
}
