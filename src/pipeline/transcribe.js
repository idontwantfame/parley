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
        const { text, words } = await stt(wavPath, cfg);
        const clean = (text || '').trim();
        if (!clean) continue; // silent track — not a failure, just nothing said
        const lastEnd = words && words.length ? words[words.length - 1].end : 0;
        results[i] = {
          userId: t.userId,
          displayName: t.displayName,
          startMs: t.startMs,
          endMs: t.startMs + Math.round(lastEnd * 1000),
          text: clean,
        };
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

  const utterances = results.filter(Boolean);
  return { utterances, failures };
}
