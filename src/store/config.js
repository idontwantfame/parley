import { DEFAULT_AUTO_JOIN_MIN_PEOPLE } from '../voice/decisions.js';

export const DEFAULTS = {
  summarizerProvider: 'gemini',
  summarizerModel: 'gemini-2.5-flash',
  // null = no fallback; when set, getSummarizer wraps the primary so one
  // provider outage doesn't fail a meeting whose transcript is already intact.
  summarizerFallbackProvider: null,
  summarizerFallbackModel: null,
  sttProvider: 'sidecar',
  sttModel: null,
  whisperModel: 'small',
  notesChannelId: null,
  useThread: true,
  autoJoin: true,
  autoJoinMinPeople: DEFAULT_AUTO_JOIN_MIN_PEOPLE,
  autoJoinChannelIds: null,
  sharedMicUserIds: [],
  keepAudio: false,
  language: 'auto',
  summaryLanguage: 'en',
  // null = the built-in SUMMARY_PROMPT (notes.js), resolved at summarize time so
  // prompt improvements reach every server that hasn't written its own.
  summaryPrompt: null,
  overviewPrompt: null,
  // null = the bot's Discord account name (no per-server nickname).
  botNickname: null,
};

function parseIdList(value) {
  if (value == null) return null;
  try {
    const ids = JSON.parse(value);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function fromRow(row) {
  return {
    summarizerProvider: row.summarizer_provider ?? DEFAULTS.summarizerProvider,
    summarizerModel: row.summarizer_model ?? DEFAULTS.summarizerModel,
    summarizerFallbackProvider: row.summarizer_fallback_provider ?? DEFAULTS.summarizerFallbackProvider,
    summarizerFallbackModel: row.summarizer_fallback_model ?? DEFAULTS.summarizerFallbackModel,
    sttProvider: row.stt_provider ?? DEFAULTS.sttProvider,
    sttModel: row.stt_model ?? DEFAULTS.sttModel,
    whisperModel: row.whisper_model ?? DEFAULTS.whisperModel,
    notesChannelId: row.notes_channel_id ?? DEFAULTS.notesChannelId,
    useThread: row.use_thread == null ? DEFAULTS.useThread : !!row.use_thread,
    autoJoin: row.auto_join == null ? DEFAULTS.autoJoin : !!row.auto_join,
    autoJoinMinPeople: row.auto_join_min_people ?? DEFAULTS.autoJoinMinPeople,
    autoJoinChannelIds: parseIdList(row.auto_join_channel_ids),
    sharedMicUserIds: parseIdList(row.shared_mic_user_ids) ?? [],
    keepAudio: !!row.keep_audio,
    language: row.language ?? DEFAULTS.language,
    summaryLanguage: row.summary_language ?? DEFAULTS.summaryLanguage,
    summaryPrompt: row.summary_prompt ?? DEFAULTS.summaryPrompt,
    overviewPrompt: row.overview_prompt ?? DEFAULTS.overviewPrompt,
    botNickname: row.bot_nickname ?? DEFAULTS.botNickname,
  };
}

export function getGuildConfig(db, guildId) {
  const row = db.sql.prepare(`SELECT * FROM guild_config WHERE guild_id = ?`).get(guildId);
  return { guildId, ...(row ? fromRow(row) : DEFAULTS) };
}

export function anyGuildUsesSidecar(db) {
  try {
    const rows = db.sql.prepare('SELECT stt_provider, shared_mic_user_ids FROM guild_config').all();
    return rows.length === 0 || rows.some((row) => (row.stt_provider ?? 'sidecar') === 'sidecar'
      || !!parseIdList(row.shared_mic_user_ids)?.length);
  } catch { return true; }
}

export function setGuildConfig(db, guildId, patch) {
  const current = getGuildConfig(db, guildId);
  // Drop undefined keys (node:sqlite cannot bind undefined) and pin guildId so a
  // stray patch key can't corrupt the row identity or the returned object.
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = { ...current, ...safePatch, guildId };
  db.sql.prepare(
    `INSERT OR REPLACE INTO guild_config
       (guild_id, summarizer_provider, summarizer_model, summarizer_fallback_provider, summarizer_fallback_model, stt_provider, stt_model, whisper_model, notes_channel_id, use_thread, auto_join, auto_join_min_people, auto_join_channel_ids, shared_mic_user_ids, language, summary_language, summary_prompt, overview_prompt, keep_audio, bot_nickname)
     VALUES (@guildId, @summarizerProvider, @summarizerModel, @summarizerFallbackProvider, @summarizerFallbackModel, @sttProvider, @sttModel, @whisperModel, @notesChannelId, @useThread, @autoJoin, @autoJoinMinPeople, @autoJoinChannelIds, @sharedMicUserIds, @language, @summaryLanguage, @summaryPrompt, @overviewPrompt, @keepAudio, @botNickname)`
  ).run({
    guildId,
    summarizerProvider: merged.summarizerProvider,
    summarizerModel: merged.summarizerModel,
    summarizerFallbackProvider: merged.summarizerFallbackProvider,
    summarizerFallbackModel: merged.summarizerFallbackModel,
    sttProvider: merged.sttProvider,
    sttModel: merged.sttModel,
    whisperModel: merged.whisperModel,
    notesChannelId: merged.notesChannelId,
    useThread: merged.useThread ? 1 : 0,
    autoJoin: merged.autoJoin ? 1 : 0,
    autoJoinMinPeople: merged.autoJoinMinPeople,
    autoJoinChannelIds: merged.autoJoinChannelIds === null ? null : JSON.stringify(merged.autoJoinChannelIds),
    sharedMicUserIds: JSON.stringify(merged.sharedMicUserIds),
    language: merged.language,
    summaryLanguage: merged.summaryLanguage,
    summaryPrompt: merged.summaryPrompt,
    overviewPrompt: merged.overviewPrompt,
    keepAudio: merged.keepAudio ? 1 : 0,
    botNickname: merged.botNickname ?? null,
  });
  return merged;
}
