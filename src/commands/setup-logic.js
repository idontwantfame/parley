import { SUPPORTED_PROVIDERS } from '../adapters/summarizer/index.js';
import { DEFAULT_MODELS } from '../adapters/summarizer/models.js';
import { LANGUAGE_CODES, SUMMARY_LANGUAGE_VALUES } from '../adapters/summarizer/languages.js';
import { STT_PROVIDERS, STT_MODELS, sttProviderReady } from '../adapters/stt/index.js';
import { parseBotName } from '../voice/nickname.js';

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];

export function providerKeyPresent(provider, env) {
  if (provider === 'gemini') return { ok: !!env.gemini.apiKey, missing: 'GEMINI_API_KEY' };
  if (provider === 'openai') return { ok: !!env.openai.apiKey, missing: 'OPENAI_API_KEY' };
  if (provider === 'opencode') return { ok: !!env.opencode.apiKey, missing: 'OPENCODE_API_KEY' };
  if (provider === 'openrouter') return { ok: !!env.openrouter.apiKey, missing: 'OPENROUTER_API_KEY' };
  if (provider === 'ollama') return { ok: !!env.ollama.url, missing: 'OLLAMA_URL' };
  return { ok: false, missing: null };
}

// Model ids are free text backed by each provider's live catalog, so only their
// shape is checked: one token of printable characters (e.g. "llama3.1:8b",
// "anthropic/claude-sonnet-4").
const MODEL_ID_MAX = 200;
const MODEL_ID = /^\S+$/;

function invalidModel(model) {
  if (typeof model !== 'string' || !MODEL_ID.test(model) || model.length > MODEL_ID_MAX) {
    return { ok: false, error: `Model must be a model id (no spaces, at most ${MODEL_ID_MAX} characters).` };
  }
  return null;
}

// Primary summarizer provider/model. A provider switch without a model takes
// that provider's default rather than keeping the old provider's model id
// (which it can't serve); a model alone applies to the current provider.
function summarizerPatch(input, env, current) {
  const model = typeof input.model === 'string' ? input.model.trim() : input.model;
  if (input.provider === undefined) {
    if (model === undefined || model === null) return { patch: {} };
    return invalidModel(model) || { patch: { summarizerModel: model } };
  }
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
    return { ok: false, error: `Unknown provider "${input.provider}". Use one of: ${SUPPORTED_PROVIDERS.join(', ')}.` };
  }
  const key = providerKeyPresent(input.provider, env);
  if (!key.ok) return { ok: false, error: `Cannot use ${input.provider}: ${key.missing} is not set in .env.` };
  if (model) return invalidModel(model) || { patch: { summarizerProvider: input.provider, summarizerModel: model } };
  if (current?.summarizerProvider === input.provider) return { patch: { summarizerProvider: input.provider } };
  return { patch: { summarizerProvider: input.provider, summarizerModel: DEFAULT_MODELS[input.provider] || null } };
}

/**
 * Validate a /setup (or dashboard) change. `current` is the guild's STORED
 * config — used to keep provider/model coherent and to validate a bare STT
 * model against the provider actually configured (never a client-sent value).
 */
export function validateSetup(input, env, current = null) {
  const summarizer = summarizerPatch(input, env, current);
  if (!summarizer.patch) return summarizer;
  const patch = { ...summarizer.patch };

  // Optional second summarizer, tried only when the primary throws. 'none' (or
  // an empty value) clears it and restores single-provider behaviour.
  if (input.fallbackProvider !== undefined) {
    const fb = input.fallbackProvider;
    if (fb === null || fb === '' || fb === 'none') {
      patch.summarizerFallbackProvider = null;
      patch.summarizerFallbackModel = null;
    } else {
      if (!SUPPORTED_PROVIDERS.includes(fb)) {
        return { ok: false, error: `Unknown fallback provider "${fb}". Use one of: ${SUPPORTED_PROVIDERS.join(', ')}, none.` };
      }
      const key = providerKeyPresent(fb, env);
      if (!key.ok) return { ok: false, error: `Cannot use ${fb} as fallback: ${key.missing} is not set in .env.` };
      patch.summarizerFallbackProvider = fb;
      // Default to this provider's own default model rather than inheriting the
      // outgoing provider's model id, which would be meaningless to it.
      patch.summarizerFallbackModel = input.fallbackModel || DEFAULT_MODELS[fb] || null;
    }
  } else if (input.fallbackModel !== undefined) {
    patch.summarizerFallbackModel = input.fallbackModel || null;
  }

  if (input.whisperModel !== undefined) {
    if (!WHISPER_MODELS.includes(input.whisperModel)) {
      return { ok: false, error: `Invalid whisper model. Use one of: ${WHISPER_MODELS.join(', ')}.` };
    }
    patch.whisperModel = input.whisperModel;
  }

  // Speech-to-text provider (sidecar | openai). Selecting a cloud
  // provider requires its API key to be set, mirroring the summarizer checks.
  if (input.sttProvider !== undefined) {
    if (!STT_PROVIDERS.includes(input.sttProvider)) {
      return { ok: false, error: `Unknown STT provider "${input.sttProvider}". Use one of: ${STT_PROVIDERS.join(', ')}.` };
    }
    const ready = sttProviderReady(input.sttProvider, env);
    if (!ready.ok) return { ok: false, error: `Cannot use ${input.sttProvider} STT: ${ready.missing} is not set in .env.` };
    patch.sttProvider = input.sttProvider;
    // A model supplied alongside the provider must belong to that provider.
    if (input.sttModel !== undefined && input.sttModel !== null && input.sttProvider !== 'sidecar') {
      if (!STT_MODELS[input.sttProvider].includes(input.sttModel)) {
        return { ok: false, error: `Invalid ${input.sttProvider} model. Use one of: ${STT_MODELS[input.sttProvider].join(', ')}.` };
      }
      patch.sttModel = input.sttModel;
    }
  } else if (input.sttModel !== undefined && input.sttModel !== null) {
    // Model changed without naming a provider: validate against the stored one.
    const provider = current?.sttProvider || 'sidecar';
    if (provider !== 'sidecar' && !STT_MODELS[provider]?.includes(input.sttModel)) {
      return { ok: false, error: `Invalid ${provider} model. Use one of: ${(STT_MODELS[provider] || []).join(', ')}.` };
    }
    patch.sttModel = input.sttModel;
  }

  if (input.notesChannelId !== undefined) patch.notesChannelId = input.notesChannelId;
  if (input.useThread !== undefined) patch.useThread = !!input.useThread;
  if (input.autoJoin !== undefined) patch.autoJoin = !!input.autoJoin;
  if (input.keepAudio !== undefined) {
    if (typeof input.keepAudio !== 'boolean') return { ok: false, error: 'Keep recordings must be true or false.' };
    patch.keepAudio = input.keepAudio;
  }
  if (input.autoJoinMinPeople !== undefined) {
    if (!Number.isSafeInteger(input.autoJoinMinPeople) || input.autoJoinMinPeople < 1) {
      return { ok: false, error: 'Auto-join minimum must be a whole number of at least 1.' };
    }
    patch.autoJoinMinPeople = input.autoJoinMinPeople;
  }
  if (input.autoJoinChannelIds !== undefined) {
    const ids = input.autoJoinChannelIds;
    if (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[1-9]\d{16,19}$/.test(id)))) {
      return { ok: false, error: 'Auto-join channels must be Discord voice channel IDs.' };
    }
    patch.autoJoinChannelIds = ids === null ? null : [...new Set(ids)];
  }
  if (input.sharedMicUserIds !== undefined) {
    const ids = input.sharedMicUserIds;
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !/^[1-9]\d{16,19}$/.test(id))) {
      return { ok: false, error: 'Select up to 50 Discord accounts for shared microphones.' };
    }
    patch.sharedMicUserIds = [...new Set(ids)];
  }
  if (input.language !== undefined) {
    if (!LANGUAGE_CODES.has(input.language)) {
      return { ok: false, error: `Invalid language. Use one of: ${[...LANGUAGE_CODES].join(', ')}.` };
    }
    patch.language = input.language;
  }

  if (input.summary_language !== undefined) {
    if (!SUMMARY_LANGUAGE_VALUES.has(input.summary_language)) {
      return { ok: false, error: `Invalid summary language. Use one of: ${[...SUMMARY_LANGUAGE_VALUES].join(', ')}.` };
    }
    patch.summaryLanguage = input.summary_language;
  }

  if (input.botNickname !== undefined) {
    const name = parseBotName(input.botNickname);
    if (!name.ok) return { ok: false, error: name.error };
    patch.botNickname = name.value;
  }

  for (const [field, label, limit] of [
    ['summaryPrompt', 'Summary prompt', 20000],
    ['overviewPrompt', 'Overview prompt', 2000],
  ]) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) {
      patch[field] = null;
      continue;
    }
    const prompt = typeof value === 'string' ? value.trim() : '';
    if (!prompt || prompt.length > limit) {
      return { ok: false, error: `${label} must be non-empty text of at most ${limit.toLocaleString('en-US')} characters.` };
    }
    patch[field] = prompt;
  }

  return { ok: true, patch };
}

export { WHISPER_MODELS };

// Discord rejects messages over 2000 characters; prompts alone can be 20k.
const DISCORD_MESSAGE_LIMIT = 2000;
const PROMPT_FIELDS = new Set(['summaryPrompt', 'overviewPrompt']);

/** The /setup confirmation: the merged config with long prompts summarized. */
export function formatConfigReply(config) {
  const shown = Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (!PROMPT_FIELDS.has(key)) return [key, value];
    return [key, typeof value === 'string' ? `custom (${value.length} chars)` : 'default'];
  }));
  const text = `✅ Config updated:\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\``;
  if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  return "✅ Config updated. The full settings are too long to show here — see the dashboard's Setup page.";
}

export function availableProviders(env) {
  return SUPPORTED_PROVIDERS.map((provider) => ({ provider, ...providerKeyPresent(provider, env) }));
}
