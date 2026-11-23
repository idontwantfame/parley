import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { resolveAuthSettings } from './auth-settings.js';
const REQUIRED = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export function resolveDataDir(env = process.env, exists = existsSync, cwd = process.cwd()) {
  if (env.DATA_DIR) return env.DATA_DIR;
  if (exists('/data')) return '/data';
  return cwd;
}
// The single .env the app reads at boot AND writes to from the web UI. Lives in
// DATA_DIR so edits persist across restarts (critical when DATA_DIR is a Docker
// volume; in local dev DATA_DIR is the cwd, so this is just ./.env as before).
export function resolveEnvFile(env = process.env) {
  return env.PARLEY_ENV_FILE || join(resolveDataDir(env), '.env');
}

export function resolveRecordingNickname(env = process.env) {
  const nickname = env.DISCORD_RECORDING_NICKNAME?.trim();
  if (nickname && Array.from(nickname).length <= 32 && !/[\u0000-\u001f\u007f]/.test(nickname)) {
    return nickname;
  }
  return '[REC] Meeting Bot';
}
// Load the cwd .env first (back-compat / `node --env-file`), then overlay the
// persistent DATA_DIR/.env so values saved from the web UI win.
dotenv.config({ override: true });
{
  const dataEnv = resolveEnvFile();
  if (existsSync(dataEnv)) dotenv.config({ path: dataEnv, override: true });
}
export function hasDiscordCreds(env = config) {
  return !!(env.discordToken && env.discordClientId);
}
export function validateEnv(env = process.env) {
  const empty = REQUIRED.filter((k) => !env[k] || env[k].trim() === '');
  if (empty.length) throw new Error(`Missing or empty required env: ${empty.join(', ')}`);
  return true;
}

// Imported recordings (dashboard upload → local sidecar). Uploads wait in
// DATA_DIR/imports/ until converted; anything left there at boot is stale.
export const IMPORT_UPLOADS_DIR = 'imports';
export const DEFAULT_IMPORT_MAX_BYTES = 2 * 1024 ** 3; // 2 GiB
export const DEFAULT_IMPORT_STT_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

function positiveInt(value, fallback) {
  const text = String(value ?? '').trim();
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function resolveImportLimits(env = process.env) {
  return {
    importMaxBytes: positiveInt(env.IMPORT_MAX_BYTES, DEFAULT_IMPORT_MAX_BYTES),
    importSttTimeoutMs: positiveInt(env.IMPORT_STT_TIMEOUT_MS, DEFAULT_IMPORT_STT_TIMEOUT_MS),
  };
}

const retention = process.env.AUDIO_RETENTION_DAYS?.trim();
const meetingRetention = process.env.MEETING_RETENTION_DAYS?.trim();
export const config = {
  dataDir: resolveDataDir(),
  exportDir: process.env.EXPORT_DIR || join(resolveDataDir(), 'exports'),
  autoExport: !['0', 'false'].includes((process.env.AUTO_EXPORT || '').toLowerCase()),
  audioRetentionDays: retention && /^\d+$/.test(retention) && Number.isSafeInteger(Number(retention)) ? Number(retention) : 30,
  meetingRetentionDays: meetingRetention && /^\d+$/.test(meetingRetention) ? Number(meetingRetention) : 0,
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  recordingNickname: resolveRecordingNickname(),
  notesBaseUrl: process.env.WEB_PUBLIC_URL?.trim(),
  sttUrl: process.env.STT_URL || 'http://127.0.0.1:8000',
  gemini: { apiKey: process.env.GEMINI_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' },
  opencode: { apiKey: process.env.OPENCODE_API_KEY, baseUrl: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1' },
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY, baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1' },
  ollama: { url: (process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, '') },
  ...resolveImportLimits(),
  // Dashboard sign-in (SSO + password login). Replaced as a whole, never
  // mutated, when the dashboard saves new settings (src/store/oidc-settings.js).
  auth: resolveAuthSettings(),
};
