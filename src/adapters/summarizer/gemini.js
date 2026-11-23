// Gemini through its generateContent REST endpoint. The SDK always uses
// Node's global fetch, which stops waiting for response headers after 300 s;
// a long transcript on a slow model needs longer, so requests go through the
// same long-generation HTTP client as the other providers (adapters/http.js).
import { SchemaType } from '@google/generative-ai';
import { summaryPrompt } from './notes.js';
import { parseNotes } from './parse.js';
import { summaryLanguageInstruction } from './languages.js';
import { httpError, withRetry } from './errors.js';
import { CHAT_TIMEOUT_MS } from './chat.js';
import { fetchWithTimeouts, withTimeoutMessage } from '../http.js';
import { config } from '../../config/env.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const PROVIDER = 'Gemini';
// Finish reasons for which Gemini withholds the answer (as the SDK's text() does).
const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

export const NOTES_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    tldr: { type: SchemaType.STRING },
    topics: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          points: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ['title', 'points'],
      },
    },
    decisions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    openQuestions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    actionItems: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          assignee: { type: SchemaType.STRING },
          task: { type: SchemaType.STRING },
        },
        required: ['task'],
      },
    },
  },
  required: ['tldr', 'topics', 'decisions', 'openQuestions', 'actionItems'],
};

// Kept under its original name for existing callers/tests.
export const parseGeminiNotes = parseNotes;

// Gemini's error body is {"error":{"message":…}}; quote just the message.
function errorMessage(bodyText) {
  try {
    const message = JSON.parse(bodyText)?.error?.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch { /* not JSON */ }
  return bodyText;
}

/** The answer text of a generateContent reply (throws when it was withheld). */
export function replyText(body) {
  const candidate = body?.candidates?.[0];
  if (!candidate) {
    const reason = body?.promptFeedback?.blockReason;
    if (reason) throw new Error(`Gemini blocked the request (${reason}).`);
    return '';
  }
  if (BLOCKED_FINISH.has(candidate.finishReason)) throw new Error(`Gemini blocked the answer (${candidate.finishReason}).`);
  return (candidate.content?.parts ?? []).map((part) => part.text ?? '').join('');
}

export class GeminiSummarizer {
  // opts (tests): { baseUrl, timeoutMs, fetchImpl }
  constructor(model, apiKey = config.gemini.apiKey, { baseUrl = GEMINI_BASE_URL, timeoutMs = CHAT_TIMEOUT_MS, fetchImpl } = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in .env');
    this.apiKey = apiKey;
    this.modelName = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl ?? fetchWithTimeouts(timeoutMs);
  }

  // One generateContent call: retried on 5xx, never after a timeout.
  generate(prompt, generationConfig) {
    const url = `${this.baseUrl}/${API_VERSION}/models/${encodeURIComponent(this.modelName)}:generateContent`;
    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(generationConfig ? { generationConfig } : {}) };
    return withTimeoutMessage(() => withRetry(async () => {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw httpError(PROVIDER, res.status, errorMessage(await res.text().catch(() => '')));
      return res.json();
    }), PROVIDER, this.timeoutMs);
  }

  async summarize(transcript, meta) {
    const prompt = `${summaryPrompt(meta)}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nMeeting: ${meta.channelName || ''} on ${meta.date || ''}\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    // Force valid JSON in the StructuredNotes shape; free-text mode let
    // gemini-2.5-flash emit truncated/malformed JSON that dumped the whole
    // blob into tldr (parseNotes now rejects such replies).
    const body = await this.generate(prompt, { responseMimeType: 'application/json', responseSchema: NOTES_SCHEMA });
    if (body?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini stopped at its output limit before finishing the meeting notes. Try a model with a larger output limit.');
    }
    return parseNotes(replyText(body), { provider: 'Gemini', allowProse: meta.summaryPrompt != null });
  }

  async ask(prompt) {
    return replyText(await this.generate(prompt, null)); // no responseSchema → free text
  }
}
