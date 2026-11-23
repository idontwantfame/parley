import { completionAnswer, notesFromCompletion } from './parse.js';
import { summaryPrompt } from './notes.js';
import { summaryLanguageInstruction } from './languages.js';
import { CHAT_TIMEOUT_MS, chatFetch, postChatCompletion } from './chat.js';
import { config } from '../../config/env.js';

// OpenRouter is an OpenAI-compatible gateway to many vendors' models
// (https://openrouter.ai/api/v1 — /models, /chat/completions), authed with
// OPENROUTER_API_KEY. Model ids are vendor-namespaced (`vendor/model`, e.g.
// `openai/gpt-4o-mini`). Same chat/completions shape as OpenAISummarizer; kept
// a separate class so the missing-key message and retry/error labels name
// OpenRouter rather than OpenAI.
export class OpenRouterSummarizer {
  constructor(model, baseUrl = config.openrouter.baseUrl, apiKey = config.openrouter.apiKey, fetchImpl, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set in .env');
    this.model = model; this.baseUrl = baseUrl; this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = chatFetch(fetchImpl, timeoutMs);
  }
  // Optional attribution headers — OpenRouter uses these for app rankings.
  headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/SakethKanchi/parley',
      'X-Title': 'Parley',
    };
  }
  complete(prompt) {
    return postChatCompletion({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers(),
      payload: { model: this.model, messages: [{ role: 'user', content: prompt }] },
      provider: 'OpenRouter',
      timeoutMs: this.timeoutMs,
    });
  }
  async summarize(transcript, meta) {
    const prompt = `${summaryPrompt(meta)}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    const body = await this.complete(prompt);
    return notesFromCompletion(body, { provider: 'OpenRouter', allowProse: meta.summaryPrompt != null });
  }
  async ask(prompt) {
    return completionAnswer(await this.complete(prompt));
  }
}
