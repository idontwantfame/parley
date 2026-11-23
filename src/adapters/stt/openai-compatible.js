import { basename } from 'node:path';
import { errorBodySnippet, fileBlob, isTimeoutError } from '../http.js';

// One adapter for every OpenAI-compatible speech-to-text endpoint
// (POST {baseUrl}/audio/transcriptions). OpenAI and other OpenAI-compatible
// providers speak this exact shape, so a single implementation covers them —
// only baseUrl/key/model differ.
//
// Whisper models are asked for `verbose_json` with word-level timestamps so the
// response carries the same `{ text, words: [{ word, start, end }] }` our
// pipeline already consumes from the local sidecar. OpenAI's gpt-4o
// transcription models only return plain `json` (text, no timings), so their
// text becomes one segment spanning the whole track.
const TEXT_ONLY_MODELS = /^gpt-.*transcribe/i;

function supportsWordTimestamps(model) {
  return !TEXT_ONLY_MODELS.test(model || '');
}

// Length of a PCM WAV in seconds, from its 44-byte header; null if not a WAV.
async function wavDurationSec(blob) {
  const header = Buffer.from(await blob.slice(0, 44).arrayBuffer());
  if (header.length < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
  const byteRate = header.readUInt32LE(28);
  return byteRate > 0 ? header.readUInt32LE(40) / byteRate : null;
}

function buildForm(file, filePath, opts) {
  const form = new FormData();
  form.append('file', file, basename(filePath));
  if (opts.model) form.append('model', opts.model);
  if (supportsWordTimestamps(opts.model)) {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    // Segments give sentence-level transcript lines the dashboard can seek to.
    form.append('timestamp_granularities[]', 'segment');
  } else {
    form.append('response_format', 'json');
  }
  // Whisper auto-detects language when none is supplied; only pin it when
  // the user picked a specific ISO code (our 'auto' sentinel means detect).
  if (opts.language && opts.language !== 'auto') form.append('language', opts.language);
  if (opts.vocabulary) form.append('prompt', opts.vocabulary);
  return form;
}

export function createOpenAICompatibleSTT({ baseUrl, apiKey, label = 'STT' }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const retries = deps.retries ?? 1;
  // Cloud transcription is fast, but a cold connection or
  // a large file warrants headroom. Far below the sidecar's CPU-bound ceiling.
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/audio/transcriptions`;

  async function post(file, filePath, opts) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: buildForm(file, filePath, opts),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const body = await errorBodySnippet(res);
    // A 4xx (bad key, unsupported parameter, quota) fails the same way again.
    throw Object.assign(new Error(`${label} HTTP ${res.status}${body ? `: ${body}` : ''}`),
      { status: res.status, noRetry: res.status < 500 });
  }

  return async function transcribe(filePath, opts = {}) {
    if (!apiKey) throw new Error(`${label}: API key is not set.`);
    const file = await fileBlob(filePath, deps);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const json = await post(file, filePath, opts);
        const durationSec = supportsWordTimestamps(opts.model) ? null : await wavDurationSec(file);
        return normalize(json, { durationSec });
      } catch (err) {
        if (isTimeoutError(err)) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
        lastErr = err;
        if (err?.noRetry) break;
      }
    }
    throw lastErr;
  };
}

// Coerce an OpenAI-compatible transcription response into our { text, words } shape.
// Prefer top-level word timestamps; fall back to deriving them from segments so
// downstream endMs math still works even if a provider omits the words array.
// A text-only response becomes one segment covering the track (durationSec).
export function normalize(json, { durationSec = null } = {}) {
  const text = (json?.text || '').trim();
  let words = Array.isArray(json?.words)
    ? json.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
    : [];
  if (!words.length && Array.isArray(json?.segments)) {
    words = json.segments
      .filter((s) => typeof s.end === 'number')
      .map((s) => ({ word: s.text, start: s.start, end: s.end }));
  }
  if (!words.length && text && durationSec > 0) words = [{ word: text, start: 0, end: durationSec }];
  const segments = Array.isArray(json?.segments)
    ? json.segments
      .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end))
      .map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim() }))
    : [];
  return { text, words, ...(segments.length ? { segments } : {}), language: json?.language };
}
