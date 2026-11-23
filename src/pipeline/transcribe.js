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

// ── Diarized results (imported recordings) ─────────────────────────────────
// One file holds every speaker; the sidecar labels each word and segment with
// a speaker ("SPEAKER_00", or null when it couldn't tell).

const speakerLabel = (x) => (typeof x?.speaker === 'string' && x.speaker.trim() ? x.speaker : null);
const byStart = (a, b) => a.start - b.start;

// Each word's speaker, falling back to the segment its midpoint falls in.
// Words and segments are both in time order, so one pass walks the segments.
function withSegmentSpeakers(words, segments) {
  let i = 0;
  return words.map((w) => {
    const own = speakerLabel(w);
    if (own !== null) return { ...w, speaker: own };
    const mid = (w.start + w.end) / 2;
    while (i < segments.length && segments[i].end < mid) i++;
    const segment = segments[i];
    return { ...w, speaker: segment && segment.start <= mid ? speakerLabel(segment) : null };
  });
}

// WhisperX leaves words outside every speaker turn unassigned (null). A stray
// one belongs to the speaker around it (the previous word's, or the first
// known speaker at the very start), not to an "Unknown speaker" line of its
// own. If no word has a speaker at all, they all stay unknown.
function fillUnassigned(words) {
  let current = words.find((w) => w.speaker !== null)?.speaker ?? null;
  return words.map((w) => {
    if (w.speaker !== null) {
      current = w.speaker;
      return w;
    }
    return { ...w, speaker: current };
  });
}

// Consecutive words by the same speaker: [{ speaker, words }].
function speakerRuns(words) {
  const runs = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === w.speaker) last.words.push(w);
    else runs.push({ speaker: w.speaker, words: [w] });
  }
  return runs;
}

/**
 * Split a diarized STT result into timed lines (seconds from the file start),
 * each tagged with its speaker label (null = unknown): words split at every
 * speaker change, then into sentences like transcriptLines. Without word
 * timings each segment is a line; failing that, the whole text is one.
 */
export function diarizedLines({ text = '', words = [], segments = [] } = {}) {
  const timedSegments = (Array.isArray(segments) ? segments : []).filter(isTimed).sort(byStart);
  const timedWords = (Array.isArray(words) ? words : [])
    .filter((w) => isTimed(w) && typeof w.word === 'string' && w.word.trim()).sort(byStart);
  if (timedWords.length) {
    return speakerRuns(fillUnassigned(withSegmentSpeakers(timedWords, timedSegments)))
      .flatMap(({ speaker, words: run }) => groupWords(run).map((line) => ({ ...line, speaker })));
  }
  const fromSegments = timedSegments
    .map((seg) => ({ start: seg.start, end: seg.end, text: String(seg.text ?? '').trim(), speaker: speakerLabel(seg) }))
    .filter((line) => line.text);
  if (fromSegments.length) return fromSegments;
  return transcriptLines({ text, words }).map((line) => ({ ...line, speaker: null }));
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
// The STT adapters upload a .pcm track as WAV straight from the PCM file
// (adapters/http.js fileBlob), so by default nothing is converted on disk.
// `deps.convert(pcmPath, wavPath)` (tests) still writes a separate file, which
// is then cleaned up.
export async function transcribeTracks(tracks, cfg = {}, deps = {}) {
  const convert = deps.convert || null;
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
      const wavPath = convert ? t.pcmPath.replace(/\.pcm$/, '.wav') : null;
      let failed = false;
      try {
        if (convert) await convert(t.pcmPath, wavPath);
        const lines = transcriptLines(await stt(wavPath ?? t.pcmPath, cfg));
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
        if (wavPath) await cleanup(wavPath);
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
