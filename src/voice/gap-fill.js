// Discord sends no RTP packets while a speaker pauses mid-turn (sub-second gaps
// stay inside one receive stream), so a turn's decoded PCM comes out shorter
// than the wall-clock time it covered. mix.js places turns only by their start
// offset, so without correction mixed.wav drifts and in-turn transcript
// timestamps run early. We re-insert those pauses as zero samples.
//
// Rule: keep the PCM written so far in step with the wall clock measured from
// the turn's first chunk. When a chunk arrives later than the audio written so
// far by more than a jitter allowance, pad the difference (capped per gap) with
// silence first. Because it compares totals rather than single gaps, a delayed
// burst of packets cannot compound: any overshoot is absorbed by the next real
// pause. Timestamps are taken as decoded chunks reach the filler, which tracks
// packet arrival closely unless the disk write itself stalls; the cap bounds
// what such a stall can add.
import { Transform } from 'node:stream';

export const PCM_BYTES_PER_MS = 32;   // s16le, 16 kHz, mono
export const GAP_JITTER_MS = 60;      // allowance beyond the 20 ms frame cadence
export const MAX_GAP_FILL_MS = 1_000; // a turn ends after 1 s of silence anyway

/**
 * Pure planner. `state` = { originMs: number|null, writtenBytes: number } — the
 * caller adds fillBytes + the chunk length to writtenBytes afterwards.
 * Returns { fillBytes, originMs } (originMs moves forward when a gap is capped).
 */
export function planGapFill(state, arrivalMs, {
  jitterMs = GAP_JITTER_MS, maxFillMs = MAX_GAP_FILL_MS, bytesPerMs = PCM_BYTES_PER_MS,
} = {}) {
  if (state.originMs === null) return { fillBytes: 0, originMs: arrivalMs };
  const deficitMs = arrivalMs - state.originMs - state.writtenBytes / bytesPerMs;
  if (deficitMs <= jitterMs) return { fillBytes: 0, originMs: state.originMs };
  const fillMs = Math.min(deficitMs, maxFillMs);
  const fillBytes = Math.floor((fillMs * bytesPerMs) / 2) * 2; // whole 16-bit samples
  return { fillBytes, originMs: state.originMs + (deficitMs - fillMs) };
}

/** PCM Transform that inserts silence for the pauses planGapFill detects. */
export function createGapFiller({ now = Date.now, ...options } = {}) {
  let state = { originMs: null, writtenBytes: 0 };
  return new Transform({
    transform(chunk, _encoding, done) {
      const { fillBytes, originMs } = planGapFill(state, now(), options);
      if (fillBytes > 0) this.push(Buffer.alloc(fillBytes));
      state = { originMs, writtenBytes: state.writtenBytes + fillBytes + chunk.length };
      done(null, chunk);
    },
  });
}
