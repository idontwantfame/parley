import { createWriteStream, mkdirSync } from 'node:fs';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { pcmName } from './audio.js';
import { createGapFiller } from './gap-fill.js';

// A speaking turn's receive stream ends after this much silence.
export const END_OF_TURN_SILENCE_MS = 1_000;
// Upper bound for flushing one track on stop, so /leave or a shutdown can't hang
// on a wedged stream (the shutdown path has to fit Docker's 10 s grace).
export const TRACK_FLUSH_TIMEOUT_MS = 3_000;

// Pure bookkeeping of per-user tracks for a single meeting; unit-testable.
// `active` holds turns still receiving audio (one per user); a turn leaves it as
// soon as its input ends, so the same user can start a new turn while the old
// file is still flushing. Finished files are recorded into `done`.
export class TrackRegistry {
  constructor() { this.active = new Map(); this.done = []; }
  isActive(userId) { return this.active.has(userId); }
  begin(userId, displayName, startMs, pcmPath, handles = {}) {
    const entry = { userId, displayName, startMs, pcmPath, ...handles };
    this.active.set(userId, entry);
    return entry;
  }
  /** Free the user's slot; with `entry`, only if that turn still holds it. */
  release(userId, entry = null) {
    const t = this.active.get(userId);
    if (!t || (entry && t !== entry)) return null;
    this.active.delete(userId);
    return t;
  }
  record(t) {
    this.done.push({ userId: t.userId, displayName: t.displayName, startMs: t.startMs, pcmPath: t.pcmPath });
  }
  finish(userId) {
    const t = this.release(userId);
    if (t) this.record(t);
    return t;
  }
  discard(userId) { return this.release(userId); }
  list() { return [...this.done]; }
}

const writable = (s) => !s.destroyed && !s.writableEnded;

// Hand over packets the receive stream still buffers, so ending it loses nothing.
function drainInto(readable, target) {
  if (readable.destroyed || typeof readable.read !== 'function') return;
  for (let chunk = readable.read(); chunk !== null; chunk = readable.read()) {
    if (writable(target)) target.write(chunk);
  }
}

/**
 * Wire one speaking turn: opus packets → decoder → gap filler → PCM file.
 * Every stream has an error listener, so a failing disk (ENOSPC, EMFILE, a
 * deleted meeting dir) ends just this track instead of crashing the process.
 * Ending — naturally or via stop() — closes the input and lets the decoder
 * flush into the file before it closes, so buffered audio isn't dropped.
 * Returns { stop, closed }; both resolve { bytesWritten } once the file closed.
 */
export function openTrack({
  opusStream, decoder, filler, out, label, onInputEnd = () => {},
  log = console, flushTimeoutMs = TRACK_FLUSH_TIMEOUT_MS,
}) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  out.once('close', () => resolveClosed({ bytesWritten: out.bytesWritten ?? 0 }));

  // Consume packets eagerly (flowing mode, ignoring backpressure) so nothing
  // waits inside the receive stream, whose own end-of-turn destroy() would
  // discard it. Opus packets are ~100 bytes, so the decoder buffering a disk
  // stall's worth of them is cheap.
  const onPacket = (packet) => { if (writable(decoder)) decoder.write(packet); };
  let inputEnded = false;
  const finishInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    opusStream.off('data', onPacket);
    drainInto(opusStream, decoder);
    if (writable(decoder)) decoder.end();
    onInputEnd();
  };
  const abort = () => {
    finishInput();
    for (const s of [opusStream, decoder, filler, out]) s.destroy?.();
  };

  opusStream.on('data', onPacket);
  opusStream.once('end', finishInput);
  opusStream.once('close', finishInput);
  opusStream.on('error', (err) => {
    log.warn(`[capture] ${label}: receive stream error (${err.message}); ending this turn.`);
    finishInput();
  });
  decoder.on('error', (err) => {
    log.warn(`[capture] ${label}: could not decode audio (${err.message}); keeping what was captured.`);
    if (writable(filler)) filler.end();
  });
  filler.on('error', (err) => {
    log.warn(`[capture] ${label}: audio processing failed (${err.message}); keeping what was captured.`);
    if (writable(out)) out.end();
  });
  out.on('error', (err) => {
    log.error(`[capture] ${label}: could not write audio (${err.code || err.message}); ending this track, the meeting continues.`);
    abort();
  });
  decoder.pipe(filler).pipe(out);

  return {
    closed,
    stop() {
      finishInput();
      opusStream.destroy?.();
      const timer = setTimeout(() => {
        log.warn(`[capture] ${label}: audio flush timed out; closing the track.`);
        abort();
      }, flushTimeoutMs);
      timer.unref?.();
      return closed.finally(() => clearTimeout(timer));
    },
  };
}

// Side-effecting wiring used by MeetingManager; openTrack and TrackRegistry carry
// the logic and are unit-tested with fake streams.
// `onSpeaker(userId, displayName)` fires the first time a member speaks, so the
// caller can record latecomers who joined after the meeting started.
const createOpusDecoder = () => new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 320 });

export function attachCapture({
  connection, guild, audioDir, registry, meetingId = null,
  now = () => Date.now(), onSpeaker = null, log = console, createDecoder = createOpusDecoder,
}) {
  mkdirSync(audioDir, { recursive: true });
  const tracks = new Set(); // every turn whose file hasn't closed yet

  const onStart = (userId) => {
    // The whole body is guarded: this runs inside a Discord voice event
    // emitter, so ANY synchronous throw here (e.g. a native opus module that
    // fails to load after a system libc upgrade) becomes an uncaught exception
    // that kills the entire process mid-meeting. Never let one bad speaking
    // turn take the bot down — log it and skip just that track.
    try {
      if (registry.isActive(userId)) return;
      const member = guild.members.cache.get(userId);
      if (!member || member.user.bot) return;

      const startMs = now();
      const pcmPath = `${audioDir}/${pcmName(userId, startMs)}`;
      // Build the decoder BEFORE subscribing, and release the subscription if
      // opening the file throws: an orphaned receive stream would stay in the
      // receiver and swallow this user's later turns.
      const decoder = createDecoder();
      const filler = createGapFiller({ maxFillMs: END_OF_TURN_SILENCE_MS });
      const opusStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: END_OF_TURN_SILENCE_MS },
      });
      let out;
      try {
        out = createWriteStream(pcmPath);
      } catch (err) {
        opusStream.destroy?.();
        throw err;
      }
      let entry = null;
      const track = openTrack({
        opusStream, decoder, filler, out,
        label: `meeting ${meetingId ?? audioDir} user ${userId}`,
        onInputEnd: () => registry.release(userId, entry),
        log,
      });
      entry = registry.begin(userId, member.displayName, startMs, pcmPath, { stop: track.stop });
      tracks.add(track);
      track.closed.then(({ bytesWritten }) => {
        registry.release(userId, entry);
        if (bytesWritten > 0) registry.record(entry); // an unwritable file isn't a track
        tracks.delete(track);
      });
      // Record anyone who actually speaks as an attendee (covers latecomers who
      // joined after the start-of-meeting snapshot). Idempotent downstream.
      if (onSpeaker) { try { onSpeaker(userId, member.displayName); } catch { /* ignore */ } }
    } catch (err) {
      log.error(`[capture] failed to start recording track for user ${userId}: ${err.message}`);
    }
  };

  connection.receiver.speaking.on('start', onStart);

  return {
    // End every still-open speaking turn and wait for its PCM to flush, so a
    // manual /leave or auto-leave never loses the final in-flight utterance.
    // Detach the listener FIRST so a new speaking-start between here and the
    // connection being destroyed can't open an untracked stream (leaked handle
    // + orphan .pcm + lost audio, since registry.list() was already snapshotted).
    async stopAll() {
      connection.receiver.speaking.off('start', onStart);
      await Promise.all([...tracks].map((t) => t.stop()));
    },
  };
}
