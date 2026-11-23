import { convertPcmToWav } from '../voice/audio.js';
import { getSTT, resolveSttModel } from '../adapters/stt/index.js';
import { unlink } from 'node:fs/promises';

// Speech-to-text engines only use a short hint: faster-whisper keeps ~223
// hotword tokens and OpenAI the last 224 prompt tokens. ~800 characters is
// about 200 tokens, so the rest of a long vocabulary was uploaded per track
// for nothing.
export const VOCABULARY_HINT_MAX_CHARS = 800;

/** The first whole vocabulary terms (one per line) that fit the hint budget. */
export function vocabularyHint(vocabulary, maxChars = VOCABULARY_HINT_MAX_CHARS) {
  const terms = String(vocabulary || '').split('\n').map((t) => t.trim()).filter(Boolean);
  let hint = '';
  for (const term of terms) {
    const next = hint ? `${hint}, ${term}` : term;
    if (next.length > maxChars) break;
    hint = next;
  }
  return hint;
}

// Transcript lines are sentence-sized so the dashboard can seek the recording
// to any of them. A line also breaks at a long pause, and is capped in length.
export const LINE_PAUSE_SEC = 1;
export const LINE_MAX_SEC = 30;
const SENTENCE_END = /[.!?…。！？]["')\]»”’]*$/;

const isTimed = (x) => Number.isFinite(x?.start) && Number.isFinite(x?.end);

// Group word timestamps into lines. faster-whisper words carry their own
// leading space (" Hello"); OpenAI words don't, so those are joined with one.
function groupWords(words) {
  const spaced = words.some((w) => /^\s/.test(w.word));
  const lines = [];
  let current = null;
  for (const w of words) {
    if (current && (w.start - current.end > LINE_PAUSE_SEC || w.end - current.start > LINE_MAX_SEC)) {
      lines.push(current);
      current = null;
    }
    const piece = spaced || !current ? w.word : ` ${w.word}`;
    current = current ? { ...current, end: w.end, text: current.text + piece } : { start: w.start, end: w.end, text: piece };
    if (SENTENCE_END.test(w.word.trim())) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
}

/**
 * Split one track's STT result into timed lines (seconds from the track
 * start): the engine's own segments when it returns them, else words grouped
 * into sentences, else the whole text as one line (older sidecars, text-only
 * providers).
 */
export function transcriptLines({ text = '', words = [], segments } = {}) {
  const fromSegments = (Array.isArray(segments) ? segments : [])
    .filter(isTimed)
    .map((seg) => ({ start: seg.start, end: seg.end, text: String(seg.text ?? '').trim() }))
    .filter((line) => line.text);
  if (fromSegments.length) return fromSegments;
  const list = Array.isArray(words) ? words : [];
  const timedWords = list.filter((w) => isTimed(w) && typeof w.word === 'string' && w.word.trim());
  if (timedWords.length) return groupWords(timedWords);
  const clean = String(text || '').trim();
  if (!clean) return [];
  const lastEnd = list.length && Number.isFinite(list[list.length - 1].end) ? list[list.length - 1].end : 0;
  return [{ start: 0, end: lastEnd, text: clean }];
}

// Transcribes each track through a small worker pool instead of one at a
// time. Cloud STT (openai) tolerates much higher concurrency than the local
// sidecar, which is why the default differs by provider (S3 in the speed
// plan). Concurrency is always injectable via deps for tests/tuning.
//
// A failed track (bad PCM, STT hiccup, etc.) must not sink the whole
// meeting (audit A2): failures are caught per-track and collected instead
// of thrown, and the good utterances are still returned. Callers decide
// whether "some/all tracks failed" is fatal.
export async function transcribeTracks(tracks, cfg = {}, deps = {}) {
  const convert = deps.convert || convertPcmToWav;
  // Resolve the configured STT provider (sidecar | openai) once per
  // meeting. The provider default can be overridden via deps.stt in tests.
  const transcribe = getSTT(cfg, deps.env, deps.sttDeps);
  const model = resolveSttModel(cfg);
  const vocabulary = vocabularyHint(cfg.transcriptionVocabulary);
  const stt = deps.stt || ((wav) => transcribe(wav, { model, language: cfg.language, vocabulary }));
  const cleanup = deps.cleanup || (async (p) => { try { await unlink(p); } catch { /* ignore */ } });
  const concurrency = Math.max(1, deps.concurrency ?? (cfg.sttProvider === 'openai' ? 4 : 2));

  // Results are written by index so track order is preserved regardless of
  // which worker finishes first.
  const results = new Array(tracks.length);
  const failures = [];

  let nextTrack = 0;
  async function worker() {
    while (nextTrack < tracks.length) {
      const i = nextTrack++;
      const t = tracks[i];
      const wavPath = t.pcmPath.replace(/\.pcm$/, '.wav');
      let failed = false;
      try {
        await convert(t.pcmPath, wavPath);
        const lines = transcriptLines(await stt(wavPath, cfg));
        if (!lines.length) continue; // silent track — not a failure, just nothing said
        results[i] = lines.map((line) => ({
          userId: t.userId,
          displayName: t.displayName,
          startMs: t.startMs + Math.round(line.start * 1000),
          endMs: t.startMs + Math.round(line.end * 1000),
          text: line.text,
        }));
      } catch (err) {
        failed = true;
        failures.push({ userId: t.userId, displayName: t.displayName, error: err.message || String(err) });
      } finally {
        await cleanup(wavPath);
        deps.onTrackDone?.({ failed });
      }
    }
  }

  const workerCount = Math.min(concurrency, tracks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Track order is kept; each track contributes its lines in time order.
  const utterances = results.filter(Boolean).flat();
  return { utterances, failures };
}
