import { completionAnswer, notesFromCompletion } from './parse.js';
import { summaryPrompt } from './notes.js';
import { summaryLanguageInstruction } from './languages.js';
import { CHAT_TIMEOUT_MS, chatFetch, postChatCompletion } from './chat.js';
import { config } from '../../config/env.js';

// JSON mode stops a model from wrapping or trailing the notes with prose, but
// only OpenAI itself documents it, and only for these model families (older
// gpt-4 / o1-mini reject it with a 400). OPENAI_BASE_URL may point at another
// OpenAI-compatible server, so it is never sent there. It also requires the
// word "JSON" in the prompt, which a custom summary prompt may lack.
const JSON_MODE_MODELS = /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4)/i;

function supportsJsonMode(baseUrl, model, prompt) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { return false; }
  return host === 'api.openai.com' && JSON_MODE_MODELS.test(model || '') && /json/i.test(prompt);
}

export class OpenAISummarizer {
  constructor(model, baseUrl = config.openai.baseUrl, apiKey = config.openai.apiKey, fetchImpl, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set in .env');
    this.model = model; this.baseUrl = baseUrl; this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = chatFetch(fetchImpl, timeoutMs);
  }
  complete(prompt, extra = {}) {
    return postChatCompletion({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      payload: { model: this.model, messages: [{ role: 'user', content: prompt }], ...extra },
      provider: 'OpenAI',
      timeoutMs: this.timeoutMs,
    });
  }
  async summarize(transcript, meta) {
    const prompt = `${summaryPrompt(meta)}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    const jsonMode = supportsJsonMode(this.baseUrl, this.model, prompt) ? { response_format: { type: 'json_object' } } : {};
    const body = await this.complete(prompt, jsonMode);
    return notesFromCompletion(body, { provider: 'OpenAI', allowProse: meta.summaryPrompt != null });
  }
  async ask(prompt) {
    return completionAnswer(await this.complete(prompt));
  }
}
