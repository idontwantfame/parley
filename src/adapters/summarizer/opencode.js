import { completionAnswer, notesFromCompletion } from './parse.js';
import { summaryPrompt } from './notes.js';
import { summaryLanguageInstruction } from './languages.js';
import { CHAT_TIMEOUT_MS, chatFetch, postChatCompletion } from './chat.js';
import { config } from '../../config/env.js';

// OpenCode Zen Go is an OpenAI-compatible model gateway
// (https://opencode.ai/zen/go/v1 — /models, /chat/completions), authed with
// OPENCODE_API_KEY. Same chat/completions shape as OpenAISummarizer; kept a
// separate class so the missing-key message and retry/error labels name
// OpenCode rather than OpenAI.
export class OpenCodeSummarizer {
  constructor(model, baseUrl = config.opencode.baseUrl, apiKey = config.opencode.apiKey, fetchImpl, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('OPENCODE_API_KEY is not set in .env');
    this.model = model; this.baseUrl = baseUrl; this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = chatFetch(fetchImpl, timeoutMs);
  }
  complete(prompt) {
    return postChatCompletion({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      payload: { model: this.model, messages: [{ role: 'user', content: prompt }] },
      provider: 'OpenCode',
      timeoutMs: this.timeoutMs,
    });
  }
  async summarize(transcript, meta) {
    const prompt = `${summaryPrompt(meta)}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    const body = await this.complete(prompt);
    return notesFromCompletion(body, { provider: 'OpenCode', allowProse: meta.summaryPrompt != null });
  }
  async ask(prompt) {
    return completionAnswer(await this.complete(prompt));
  }
}
