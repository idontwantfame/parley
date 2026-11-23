// Turning a model's reply into StructuredNotes. A reply that can't be read must
// throw — saving it would mark the meeting done with empty notes (or a raw JSON
// blob as the TL;DR) and FallbackSummarizer would never get its turn.
import { normalizeNotes } from './notes.js';

const NOTE_KEYS = ['tldr', 'topics', 'decisions', 'openQuestions', 'actionItems'];

/** Remove reasoning models' <think>…</think> blocks, including one cut off unclosed. */
export function stripThinking(text = '') {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Notes from a model's text reply: bare JSON, fenced JSON, or JSON wrapped in
 * prose. Plain prose becomes the TL;DR only with `allowProse` (a custom summary
 * prompt may ask for it); with the built-in prompt, prose means the model
 * ignored the requested JSON shape.
 */
export function parseNotes(raw = '', { provider = 'The model', allowProse = true } = {}) {
  const text = stripThinking(raw);
  if (!text) throw new Error(`${provider} returned an empty reply instead of meeting notes.`);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  const notes = parseObject(candidate) ?? parseObject(candidate.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (notes) {
    if (!NOTE_KEYS.some((key) => key in notes)) throw new Error(`${provider} returned JSON with no meeting-notes fields.`);
    return normalizeNotes(notes);
  }
  if (fence || /[{]/.test(text) || /^\[/.test(candidate)) {
    throw new Error(`${provider} returned meeting notes that are not valid JSON (the reply may have been cut off).`);
  }
  if (!allowProse) throw new Error(`${provider} replied in prose, not JSON meeting notes.`);
  return normalizeNotes({ tldr: text });
}

/** Notes from an OpenAI-style chat completion; a reply cut off at the output limit throws. */
export function notesFromCompletion(body, { provider, allowProse }) {
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error(`${provider} stopped at its output limit before finishing the meeting notes. Try a model with a larger output limit.`);
  }
  return parseNotes(choice?.message?.content ?? '', { provider, allowProse });
}

/** The text answer of an OpenAI-style chat completion, without reasoning blocks. */
export function completionAnswer(body) {
  return stripThinking(body?.choices?.[0]?.message?.content ?? '');
}
