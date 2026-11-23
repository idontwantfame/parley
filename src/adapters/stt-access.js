// src/adapters/stt-access.js
// What every request to the transcription sidecar shares: the optional access
// key (STT_API_KEY, sent as a Bearer token), the reasons shown when the
// sidecar refuses a request, and how long to wait when it says it is busy.
import { config } from '../config/env.js';

export const SIDECAR_KEY_REJECTED = "The transcription sidecar rejected Parley's access key. Set the same STT_API_KEY for Parley and the sidecar.";
export const SIDECAR_NEEDS_KEY = 'The sidecar requires an access key; set STT_API_KEY in Parley.';

/** Authorization header for the sidecar ({} when no key is configured). Read live. */
export function sttAuthHeaders(env = config) {
  return env.sttApiKey ? { Authorization: `Bearer ${env.sttApiKey}` } : {};
}

/** The user-facing reason for a sidecar 4xx, from its status and detail. */
export function sidecarRefusal(status, detail) {
  if (status === 401 || status === 403) return detail ? `${SIDECAR_KEY_REJECTED} (${detail})` : SIDECAR_KEY_REJECTED;
  if (status === 413) return `The recording is too large for the transcription sidecar.${detail ? ` (${detail})` : ''}`;
  return `The transcription sidecar refused the recording${detail ? `: ${detail}` : ` (HTTP ${status}).`}`;
}

// A busy sidecar (503 {"detail":"busy"}) is asked again after Retry-After
// seconds (plus up to 50% jitter), at most BUSY_MAX_WAITS times or
// BUSY_MAX_TOTAL_MS in all; these waits are not failures of the track.
export const BUSY_MAX_WAITS = 10;
const BUSY_MAX_TOTAL_MS = 4 * 60 * 1000;
const BUSY_DEFAULT_MS = 5000;
const BUSY_MIN_MS = 1000;
const BUSY_MAX_MS = 30_000;
const BUSY_JITTER = 0.5;

export const isBusyReply = (status, detail) => status === 503 && String(detail).trim().toLowerCase() === 'busy';

/** Retry-After (seconds) as a bounded delay in ms. */
export function retryAfterMs(header) {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return BUSY_DEFAULT_MS;
  return Math.min(BUSY_MAX_MS, Math.max(BUSY_MIN_MS, seconds * 1000));
}

/**
 * Tracks the busy waits of one request. next(delayMs) → the jittered wait in
 * ms, or null when the budget is spent.
 */
export function busyBudget(random = Math.random) {
  let waits = 0;
  let total = 0;
  return {
    next(delayMs) {
      const wait = Math.round(delayMs * (1 + BUSY_JITTER * random()));
      if (waits >= BUSY_MAX_WAITS || total + wait > BUSY_MAX_TOTAL_MS) return null;
      waits += 1;
      total += wait;
      return wait;
    },
  };
}
