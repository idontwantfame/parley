import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { summaryPrompt } from './notes.js';
import { parseNotes } from './parse.js';
import { summaryLanguageInstruction } from './languages.js';
import { withRetry } from './errors.js';
import { config } from '../../config/env.js';

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

export class GeminiSummarizer {
  constructor(model, apiKey = config.gemini.apiKey) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in .env');
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model;
    this.model = this.genAI.getGenerativeModel({
      model,
      // Force valid JSON in the StructuredNotes shape; free-text mode let
      // gemini-2.5-flash emit truncated/malformed JSON that dumped the whole
      // blob into tldr (parseNotes now rejects such replies).
      generationConfig: { responseMimeType: 'application/json', responseSchema: NOTES_SCHEMA },
    });
  }
  async summarize(transcript, meta) {
    const prompt = `${summaryPrompt(meta)}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nMeeting: ${meta.channelName || ''} on ${meta.date || ''}\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    // GoogleGenerativeAIFetchError carries .status, so withRetry backs off on
    // transient 5xx (e.g. 503 "high demand") and surfaces 401/429 immediately.
    const result = await withRetry(() => this.model.generateContent(prompt));
    if (result.response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini stopped at its output limit before finishing the meeting notes. Try a model with a larger output limit.');
    }
    return parseNotes(result.response.text(), { provider: 'Gemini', allowProse: meta.summaryPrompt != null });
  }
  async ask(prompt) {
    const model = this.genAI.getGenerativeModel({ model: this.modelName }); // no responseSchema → free text
    const result = await withRetry(() => model.generateContent(prompt));
    return result.response.text();
  }
}
