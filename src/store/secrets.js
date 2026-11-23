// Live settings management for the web UI.
//
// Two classes of editable settings, all stored ONLY in the .env file
// (DATA_DIR/.env so they persist across restarts) and applied to the in-memory
// `config` singleton so changes take effect without an env reload:
//
//   • Provider API keys      — GEMINI/OPENAI/OPENCODE/OPENROUTER_API_KEY  (secret: presence-only)
//   • Connection settings    — DISCORD_TOKEN, DISCORD_CLIENT_ID, STT_URL, OLLAMA_URL
//
// Security: the web server binds 127.0.0.1 only. Secret values (API keys, the
// Discord token) are NEVER returned to the client — only whether they are set.
// Non-secret settings (client id, STT url) are returned as-is so the UI can
// show and edit them.

import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { config, DEFAULT_OLLAMA_URL, resolveEnvFile } from '../config/env.js';

// provider -> { env: ENV_VAR_NAME, apply(config, value) }
// Covers summarizer keys (gemini/openai/opencode/openrouter); openai's key is
// shared by its summarizer and its cloud STT provider.
const PROVIDER_SECRETS = {
  gemini: { env: 'GEMINI_API_KEY', apply: (c, v) => { c.gemini.apiKey = v; } },
  openai: { env: 'OPENAI_API_KEY', apply: (c, v) => { c.openai.apiKey = v; } },
  opencode: { env: 'OPENCODE_API_KEY', apply: (c, v) => { c.opencode.apiKey = v; } },
  openrouter: { env: 'OPENROUTER_API_KEY', apply: (c, v) => { c.openrouter.apiKey = v; } },
};

// Core connection settings. `secret: true` means the value is never returned to
// the client (the Discord token), only its presence.
const CONNECTION_SETTINGS = {
  discordToken: { env: 'DISCORD_TOKEN', secret: true, apply: (c, v) => { c.discordToken = v; } },
  discordClientId: { env: 'DISCORD_CLIENT_ID', secret: false, apply: (c, v) => { c.discordClientId = v; } },
  sttUrl: { env: 'STT_URL', secret: false, apply: (c, v) => { c.sttUrl = v || 'http://127.0.0.1:8000'; } },
  ollamaUrl: { env: 'OLLAMA_URL', secret: false, apply: (c, v) => { c.ollama = { ...c.ollama, url: v || DEFAULT_OLLAMA_URL }; } },
};

export function isSecretProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_SECRETS, provider);
}

/** Which providers have a key present right now (for the UI badges). */
export function secretStatus(env = config) {
  return {
    gemini: !!env.gemini.apiKey,
    openai: !!env.openai.apiKey,
    opencode: !!env.opencode.apiKey,
    openrouter: !!env.openrouter.apiKey,
  };
}

// Values made only of these characters are written bare; anything else (#,
// quotes, spaces, backslashes, ...) is quoted so it reads back unchanged with
// both Node's --env-file parser (util.parseEnv) and dotenv.
const BARE_ENV_VALUE = /^[\w.:/@+=,~%-]*$/;

/** Format a value for a .env line so it round-trips through both parsers. */
export function formatEnvValue(value) {
  const text = String(value ?? '');
  if (BARE_ENV_VALUE.test(text)) return text;
  // Single quotes and backticks are literal in both parsers; double quotes
  // are a last resort because they expand \n.
  const quote = ["'", '`', '"'].find((q) => !text.includes(q) && !(q === '"' && text.includes('\\n')));
  if (!quote) throw new Error('Value cannot contain single quotes, double quotes and backticks together.');
  return `${quote}${text}${quote}`;
}

/**
 * Upsert `KEY=value` in a .env file's text, preserving everything else. If the
 * key exists (even commented/empty) it's replaced in place; otherwise appended.
 * An empty value removes the key, so a default from the environment (e.g.
 * docker-compose's STT_URL) applies again instead of being overridden by KEY=.
 */
export function upsertEnvLine(text, key, value) {
  const safe = String(value ?? '');
  // Escape regex metacharacters in the key so a future non-identifier key can't
  // corrupt the match (keys are hardcoded today, but this keeps it safe).
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safe) return text.replace(new RegExp(`^${escapedKey}=.*(?:\\r?\\n|$)`, 'gm'), '');
  const line = `${key}=${formatEnvValue(safe)}`;
  const re = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => line);
  const sep = text.length && !text.endsWith('\n') ? '\n' : '';
  return `${text}${sep}${line}\n`;
}

// Guard against .env injection: a value with a newline (or other control char)
// would write extra KEY=value lines into the file, letting an attacker set
// arbitrary env vars (e.g. redirect OPENAI_BASE_URL to exfiltrate the real key).
// Reject rather than silently strip so the caller sees the bad input.
function assertEnvSafe(value) {
  if (/[\r\n\x00-\x1f]/.test(value)) {
    throw new Error('Value contains illegal control characters.');
  }
}

// Reject STT URLs that point at link-local / cloud-metadata / loopback-hijack
// targets — a settable STT endpoint that we POST recorded audio to is an SSRF
// primitive. http(s) only. Set ALLOW_REMOTE_STT=1 to permit private/remote
// hosts (the intended self-hosted case is a LAN sidecar, so private ranges are
// allowed by default; only the dangerous metadata/link-local ranges are blocked).
// URL.hostname keeps IPv6 brackets ("[fe80::1]"); strip them, and unwrap
// IPv4-mapped IPv6 ("::ffff:169.254.169.254", which WHATWG URL normalises to
// "::ffff:a9fe:a9fe") so the IPv4 rules below see the real target.
function normalizeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(?:([\d.]+)|([\da-f]{1,4}):([\da-f]{1,4}))$/.exec(host);
  if (!mapped) return host;
  if (mapped[1]) return mapped[1];
  const [hi, lo] = [parseInt(mapped[2], 16), parseInt(mapped[3], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

function isBlockedHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'metadata.google.internal' || host === '0.0.0.0' || host === '::') return true;
  if (isIP(host) === 4) return /^169\.254\./.test(host); // IPv4 link-local + cloud metadata
  return isIP(host) === 6 && /^fe[89ab][\da-f]:/.test(host); // IPv6 link-local fe80::/10
}

function assertSttUrlSafe(value) {
  if (!value) return; // clearing falls back to the default localhost sidecar
  let url;
  try { url = new URL(value); } catch { throw new Error('STT URL is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('STT URL must use http or https.');
  }
  // The STT URL is shown to every dashboard user; never store credentials in it.
  if (url.username || url.password) throw new Error('STT URL must not contain credentials.');
  if (process.env.ALLOW_REMOTE_STT === '1') return;
  if (isBlockedHost(url.hostname)) {
    throw new Error('STT URL points at a blocked address. Set ALLOW_REMOTE_STT=1 to override.');
  }
}

/** A URL with any user:password@ removed, for display. Non-URLs pass through. */
export function redactUrl(value) {
  if (!value) return value;
  let url;
  try { url = new URL(value); } catch { return value; }
  if (!url.username && !url.password) return value;
  url.username = '';
  url.password = '';
  return url.href;
}

function normalizeOllamaUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Ollama URL is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS Ollama base URL without credentials, queries, or fragments.');
  }
  if (/^(169\.254\.|\[fe[89ab][\da-f]:|\[::ffff:a9fe:)/i.test(url.hostname) || url.hostname === 'metadata.google.internal') {
    throw new Error('Ollama URL must not use a metadata or link-local address.');
  }
  return url.href.replace(/\/+$/, '');
}

// Replace the env file atomically: stage a 0600 temp file next to it and
// rename it over the original, so a crash mid-write can't lose the .env. A
// file that can't be replaced by rename (e.g. a single-file bind mount) is
// rewritten in place instead.
async function writeEnvFile(envPath, text) {
  const tmp = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600); // the create mode is subject to umask
    await rename(tmp, envPath);
  } catch (error) {
    if (!['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await writeFile(envPath, text, { encoding: 'utf8', mode: 0o600 });
    await chmod(envPath, 0o600);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Persist [[KEY, value], ...] to the env file in one write (creating it if needed). */
const pendingWrites = new Map();
async function persistEnv(entries, envPath) {
  const previous = pendingWrites.get(envPath) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
    await writeEnvFile(envPath, entries.reduce((text, [key, value]) => upsertEnvLine(text, key, value), existing));
  });
  pendingWrites.set(envPath, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(envPath) === write) pendingWrites.delete(envPath);
  }
}

/**
 * Set (or clear) a provider's API key. Updates the in-memory config immediately
 * and persists to the env file. Returns the new secretStatus.
 *   provider: 'gemini' | 'openai' | 'opencode' | 'openrouter'
 *   value: string key, or '' to clear.
 */
export async function setProviderKey(provider, value, { env = config, envPath = resolveEnvFile() } = {}) {
  const spec = PROVIDER_SECRETS[provider];
  if (!spec) throw new Error(`Provider "${provider}" has no editable API key.`);
  const trimmed = String(value ?? '').trim();
  assertEnvSafe(trimmed);
  formatEnvValue(trimmed); // reject unwritable values before touching the file
  await persistEnv([[spec.env, trimmed]], envPath);
  spec.apply(env, trimmed || undefined);
  return secretStatus(env);
}

/**
 * Current connection settings for the UI: presence for secrets, value for the
 * rest. Never leaks the Discord token.
 */
export function connectionStatus(env = config) {
  let ollamaUrl = '';
  try { ollamaUrl = normalizeOllamaUrl(env.ollama?.url); } catch { /* Do not expose credentials from a legacy URL. */ }
  return {
    discordToken: { set: !!env.discordToken },
    discordClientId: { set: !!env.discordClientId, value: env.discordClientId || '' },
    sttUrl: { set: !!env.sttUrl, value: redactUrl(env.sttUrl || '') },
    ollamaUrl: { set: !!env.ollama?.url, value: ollamaUrl },
  };
}

// Validate and normalise one connection setting; throws on bad input.
function normalizeConnectionValue(key, raw) {
  const trimmed = String(raw ?? '').trim();
  assertEnvSafe(trimmed);
  if (key === 'sttUrl') assertSttUrlSafe(trimmed);
  const value = key === 'ollamaUrl' ? normalizeOllamaUrl(trimmed) : trimmed;
  formatEnvValue(value);
  return value;
}

/**
 * Apply a patch of connection settings. Only known keys are accepted. All of
 * them are validated first, then persisted in one write, then applied to the
 * live config — a bad value leaves both the file and the config untouched.
 * A value of '' clears the setting. Returns the new connectionStatus.
 */
export async function setConnection(patch = {}, { env = config, envPath = resolveEnvFile() } = {}) {
  const entries = Object.keys(patch)
    .filter((k) => Object.prototype.hasOwnProperty.call(CONNECTION_SETTINGS, k))
    .map((k) => [k, normalizeConnectionValue(k, patch[k])]);
  if (entries.length) await persistEnv(entries.map(([k, value]) => [CONNECTION_SETTINGS[k].env, value]), envPath);
  for (const [k, value] of entries) CONNECTION_SETTINGS[k].apply(env, value || undefined);
  return connectionStatus(env);
}
