import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { buildAskPrompt, askMeeting } from '../src/adapters/summarizer/ask.js';

test('fake adapter ask returns text', async () => {
  const s = new FakeSummarizer();
  assert.match(await s.ask('hi'), /fake/i);
});

test('askMeeting builds a grounded prompt and dispatches via getSummarizer', async () => {
  const prompt = buildAskPrompt('Who owns it?', 'Alice: I will.', { attendees: ['Alice'] });
  assert.match(prompt, /Alice: I will\./);
  assert.match(prompt, /Who owns it\?/);
  const ans = await askMeeting({ cfg: { summarizerProvider: 'fake' }, env: {}, question: 'q', transcript: 't', meta: {} });
  assert.equal(typeof ans, 'string');
});

const longTranscript = () => Array.from({ length: 2000 }, (_, i) =>
  i === 1234 ? 'Bob: the budget for the venue is 4000 euros' : `Alice: filler remark number ${i} about nothing in particular`).join('\n');

test('buildAskPrompt fits a long transcript to the budget, keeping instructions, question and relevant lines', () => {
  const transcript = longTranscript();
  const prompt = buildAskPrompt('What is the venue budget?', transcript, { attendees: ['Alice', 'Bob'] }, { maxChars: 3000 });
  assert.ok(prompt.length < 3600, `prompt is ${prompt.length} chars`);
  assert.match(prompt, /^Answer the question using ONLY the meeting transcript below/);
  assert.match(prompt, /Question: What is the venue budget\?$/);
  assert.match(prompt, /Bob: the budget for the venue is 4000 euros/);
  assert.match(prompt, /number 1233 /); // conversation around the match
  assert.match(prompt, /\[…\]/); // gaps are marked
  assert.match(prompt, /only excerpts/i);
});

test('buildAskPrompt falls back to the start and end when nothing matches', () => {
  const prompt = buildAskPrompt('zzz?', longTranscript(), {}, { maxChars: 2000 });
  assert.match(prompt, /number 0 /);
  assert.match(prompt, /number 1999 /);
  assert.ok(prompt.length < 2600);
});

test('askMeeting sizes the transcript for the smallest context among primary and fallback', async () => {
  const { askTranscriptBudget } = await import('../src/adapters/summarizer/ask.js');
  assert.ok(askTranscriptBudget({ summarizerProvider: 'ollama' }) <= 8000);
  assert.ok(askTranscriptBudget({ summarizerProvider: 'gemini' }) > 100_000);
  assert.equal(askTranscriptBudget({ summarizerProvider: 'gemini', summarizerFallbackProvider: 'ollama' }),
    askTranscriptBudget({ summarizerProvider: 'ollama' }));
});
