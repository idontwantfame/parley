import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSetup } from '../src/commands/setup-logic.js';

const env = { gemini: { apiKey: 'g' }, openai: { apiKey: '' }, opencode: { apiKey: '' }, openrouter: { apiKey: '' }, ollama: { url: 'http://x' }, sttUrl: 'http://127.0.0.1:8000' };

test('accepts gemini when key present', () => {
  const r = validateSetup({ provider: 'gemini', model: 'gemini-2.5-flash' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'gemini');
});

test('rejects openai when key missing', () => {
  const r = validateSetup({ provider: 'openai', model: 'gpt-x' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('rejects opencode when key missing', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENCODE_API_KEY/);
});

test('accepts opencode when key present', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, { ...env, opencode: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'opencode');
  assert.equal(r.patch.summarizerModel, 'gpt-5.5');
});

test('rejects openrouter when key missing', () => {
  const r = validateSetup({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENROUTER_API_KEY/);
});

test('accepts openrouter when key present', () => {
  const r = validateSetup({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }, { ...env, openrouter: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'openrouter');
  assert.equal(r.patch.summarizerModel, 'anthropic/claude-sonnet-4');
});

test('rejects unknown provider', () => {
  const r = validateSetup({ provider: 'bogus' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /provider/i);
});

test('validates the auto-join minimum as a positive integer', () => {
  assert.deepEqual(validateSetup({ autoJoinMinPeople: 1 }, env), { ok: true, patch: { autoJoinMinPeople: 1 } });
  assert.deepEqual(validateSetup({ autoJoinMinPeople: 4 }, env), { ok: true, patch: { autoJoinMinPeople: 4 } });
  for (const minimum of [0, -1, 1.5, '3', null]) {
    assert.equal(validateSetup({ autoJoinMinPeople: minimum }, env).ok, false);
  }
});

test('accepts whisper model + thread + autojoin booleans', () => {
  const r = validateSetup({ whisperModel: 'medium', useThread: false, autoJoin: true }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.whisperModel, 'medium');
  assert.equal(r.patch.useThread, false);
});

test('rejects invalid whisper model', () => {
  const r = validateSetup({ whisperModel: 'humongous' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /whisper/i);
});

test('accepts valid language + summary_language', () => {
  const r = validateSetup({ language: 'de', summary_language: 'en' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.language, 'de');
  assert.equal(r.patch.summaryLanguage, 'en');
});

test('accepts summary_language match', () => {
  const r = validateSetup({ summary_language: 'match' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summaryLanguage, 'match');
});

test('rejects unknown transcription language', () => {
  const r = validateSetup({ language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /language/i);
});

test('rejects unknown summary_language', () => {
  const r = validateSetup({ summary_language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /summary language/i);
});

// ── STT provider selection ───────────────────────────────────────────────────

test('accepts sidecar STT provider without a key', () => {
  const r = validateSetup({ sttProvider: 'sidecar' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'sidecar');
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('accepts openai STT with key and a valid model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-1' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'openai');
  assert.equal(r.patch.sttModel, 'whisper-1');
});

test('rejects an invalid openai STT model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-9000' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /openai model/i);
});

test('rejects an unknown STT provider', () => {
  const r = validateSetup({ sttProvider: 'magic' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /STT provider/i);
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('accepts a fallback provider whose key is present', () => {
  const r = validateSetup({ fallbackProvider: 'gemini', fallbackModel: 'gemini-2.5-flash' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackProvider, 'gemini');
  assert.equal(r.patch.summarizerFallbackModel, 'gemini-2.5-flash');
});

test('rejects a fallback provider whose key is missing', () => {
  const r = validateSetup({ fallbackProvider: 'openrouter' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENROUTER_API_KEY/);
});

test('rejects an unknown fallback provider', () => {
  const r = validateSetup({ fallbackProvider: 'bogus' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown fallback provider/);
});

test('"none" clears both fallback fields', () => {
  const r = validateSetup({ fallbackProvider: 'none' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackProvider, null);
  assert.equal(r.patch.summarizerFallbackModel, null);
});

test('a fallback provider with no model defaults to that provider\'s first suggestion', () => {
  const r = validateSetup({ fallbackProvider: 'gemini' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackModel, 'gemini-2.5-flash',
    'must not inherit the outgoing provider\'s model id');
});

test('fallback model alone updates only the model', () => {
  const r = validateSetup({ fallbackModel: 'glm-5.3' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackModel, 'glm-5.3');
  assert.equal('summarizerFallbackProvider' in r.patch, false);
});

// ── provider/model coherence + stored-config validation ──────────────────────
import { formatConfigReply } from '../src/commands/setup-logic.js';
const withOpenai = { ...env, openai: { apiKey: 'k' } };

test('switching provider without a model uses that provider\'s default, not the old model id', () => {
  const r = validateSetup({ provider: 'openai' }, withOpenai, { summarizerProvider: 'gemini', summarizerModel: 'gemini-2.5-flash' });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'openai');
  assert.equal(r.patch.summarizerModel, 'gpt-4o-mini');
});

test('switching provider without a model defaults even when the stored config is unknown', () => {
  const r = validateSetup({ provider: 'openai' }, withOpenai);
  assert.equal(r.patch.summarizerModel, 'gpt-4o-mini');
});

test('re-selecting the current provider without a model keeps the chosen model', () => {
  const r = validateSetup({ provider: 'gemini' }, env, { summarizerProvider: 'gemini', summarizerModel: 'gemini-2.5-pro' });
  assert.equal(r.ok, true);
  assert.equal('summarizerModel' in r.patch, false);
});

test('a model without a provider applies to the current provider instead of being dropped', () => {
  const r = validateSetup({ model: 'gemini-2.5-pro' }, env, { summarizerProvider: 'gemini' });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerModel, 'gemini-2.5-pro');
  assert.equal('summarizerProvider' in r.patch, false);
});

test('a model id must be a plausible identifier', () => {
  for (const model of ['', '   ', 'has space', 'x'.repeat(201)]) {
    assert.equal(validateSetup({ model }, env, { summarizerProvider: 'gemini' }).ok, false, JSON.stringify(model));
  }
});

test('an STT model alone is validated against the STORED provider, not client input', () => {
  const stored = { sttProvider: 'openai' };
  assert.equal(validateSetup({ sttModel: 'whisper-1' }, withOpenai, stored).ok, true);
  const r = validateSetup({ sttModel: 'bogus', currentSttProvider: 'sidecar' }, withOpenai, stored);
  assert.equal(r.ok, false);
  assert.match(r.error, /openai model/i);
});

test('the /setup reply summarizes long prompts and fits a Discord message', () => {
  const text = formatConfigReply({ summarizerProvider: 'gemini', summaryPrompt: 'p'.repeat(20_000), overviewPrompt: null });
  assert.ok(text.length <= 2000);
  assert.match(text, /custom \(20000 chars\)/);
  assert.match(text, /"overviewPrompt": "default"/);
  assert.match(text, /gemini/);
});

test('the /setup reply still fits when the config itself is huge', () => {
  const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(50)]));
  assert.ok(formatConfigReply(big).length <= 2000);
});
