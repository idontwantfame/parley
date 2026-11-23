import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotes, stripThinking } from '../src/adapters/summarizer/parse.js';
import { OpenAISummarizer } from '../src/adapters/summarizer/openai.js';
import { OpenCodeSummarizer } from '../src/adapters/summarizer/opencode.js';
import { OpenRouterSummarizer } from '../src/adapters/summarizer/openrouter.js';
import { GeminiSummarizer } from '../src/adapters/summarizer/gemini.js';
import { FallbackSummarizer } from '../src/adapters/summarizer/fallback.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';

const reply = (content, finish_reason = 'stop') => async () => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason }] }),
});

test('parseNotes drops <think> blocks before reading the JSON', () => {
  const n = parseNotes('<think>The user wants {json}. Let me plan.</think>\n{"tldr":"t","topics":[]}');
  assert.equal(n.tldr, 't');
  assert.equal(stripThinking('<think>still thinking when cut off'), '');
});

test('parseNotes rejects empty, truncated and non-notes JSON replies', () => {
  assert.throws(() => parseNotes('', { provider: 'OpenAI' }), /OpenAI returned an empty reply/);
  assert.throws(() => parseNotes('<think>only reasoning</think>'), /empty reply/);
  assert.throws(() => parseNotes('{"tldr": "We met", "topics": [{"title": "Bud'), /not valid JSON/);
  assert.throws(() => parseNotes('```json\n{"tldr": "x",\n```'), /not valid JSON/);
  assert.throws(() => parseNotes('{"error": "rate limited"}'), /no meeting-notes fields/);
});

test('parseNotes keeps prose as the TL;DR only when prose is allowed (custom prompt)', () => {
  assert.equal(parseNotes('We agreed to ship on Friday.', { allowProse: true }).tldr, 'We agreed to ship on Friday.');
  assert.throws(() => parseNotes('We agreed to ship on Friday.', { allowProse: false }), /not JSON/);
});

for (const [name, make] of [
  ['OpenAI', (f) => new OpenAISummarizer('gpt-4o-mini', 'http://x', 'k', f)],
  ['OpenCode', (f) => new OpenCodeSummarizer('glm', 'http://x', 'k', f)],
  ['OpenRouter', (f) => new OpenRouterSummarizer('a/b', 'http://x', 'k', f)],
]) {
  test(`${name} summarize throws on empty, cut-off or prose replies instead of saving empty notes`, async () => {
    await assert.rejects(make(reply('')).summarize('t', {}), /empty reply/);
    await assert.rejects(make(reply('{"tldr":"partial', 'length')).summarize('t', {}), /output limit/);
    await assert.rejects(make(reply('Sure! Here is a summary.')).summarize('t', {}), /not JSON/);
    const custom = await make(reply('Prose notes.')).summarize('t', { summaryPrompt: 'Write prose.' });
    assert.equal(custom.tldr, 'Prose notes.');
    assert.equal(await make(reply('<think>hmm</think>The answer.')).ask('q'), 'The answer.');
  });
}

test('an unreadable reply lets the fallback summarizer take over', async () => {
  const primary = new OpenAISummarizer('gpt-4o-mini', 'http://x', 'k', reply('{"tldr": "cut'));
  const s = new FallbackSummarizer(primary, () => new FakeSummarizer(), { label: 'openai:x', fallbackLabel: 'fake:', log: {} });
  const notes = await s.summarize('t', {});
  assert.equal(notes.tldr, 'Fake summary.');
  assert.equal(s.lastUsed, 'fake:');
});

test('OpenAI JSON mode is requested only from api.openai.com, for JSON-capable models and prompts', async () => {
  const bodies = [];
  const capture = async (_url, init) => { bodies.push(JSON.parse(init.body)); return reply('{"tldr":"x"}')(); };
  await new OpenAISummarizer('gpt-4o-mini', 'https://api.openai.com/v1', 'k', capture).summarize('t', {});
  await new OpenAISummarizer('gpt-4o-mini', 'http://localhost:1234/v1', 'k', capture).summarize('t', {});
  await new OpenAISummarizer('gpt-4', 'https://api.openai.com/v1', 'k', capture).summarize('t', {});
  await new OpenAISummarizer('gpt-4o', 'https://api.openai.com/v1', 'k', capture).summarize('t', { summaryPrompt: 'Return notes as an object.' });
  await new OpenRouterSummarizer('openai/gpt-4o-mini', 'https://openrouter.ai/api/v1', 'k', capture).summarize('t', {});
  assert.deepEqual(bodies.map((b) => b.response_format ?? null), [{ type: 'json_object' }, null, null, null, null]);
});

test('Gemini summarize throws when the reply hit MAX_TOKENS', async () => {
  const reply = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"tldr": "cut' }] } }] };
  const s = new GeminiSummarizer('gemini-2.5-flash', 'test-key', { fetchImpl: async () => new Response(JSON.stringify(reply)) });
  await assert.rejects(s.summarize('t', {}), /output limit/);
});

test('Ollama ask drops <think> blocks from the answer', async () => {
  const { OllamaSummarizer } = await import('../src/adapters/summarizer/ollama.js');
  const s = new OllamaSummarizer('qwen3', 'http://x', async () => ({ ok: true, json: async () => ({ done_reason: 'stop', message: { content: '<think>plan</think>\nIt was Vex.' } }) }));
  assert.equal(await s.ask('who?'), 'It was Vex.');
});
