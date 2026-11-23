// src/web/api-input.js
// Request-validation helpers for the dashboard API (src/web/api.js): query
// parameters, guild-settings bodies and campaign-journal edit conflicts.

export const MEETING_PAGE_MAX = 100;

/** True for an absent or single query value (rejects ?q=a&q=b and ?q[x]=1). */
export function isSingleQuery(value) {
  return value === undefined || typeof value === 'string';
}

/**
 * Optional positive-integer query value: `fallback` when absent, NaN when
 * repeated, malformed or outside 1..max.
 */
export function intQuery(value, max, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return NaN;
  const n = Number(value);
  return n >= 1 && n <= max ? n : NaN;
}

// Guild settings only admins may change: which STT backend and model receive
// the audio (cloud API cost, or the model the local sidecar must load), when
// the bot joins calls on its own, the summarizer's instructions, and audio
// retention, and the bot's visible name in the server.
export const ADMIN_CONFIG_FIELDS = [
  'sttProvider', 'sttModel', 'whisperModel', 'autoJoin', 'autoJoinMinPeople', 'autoJoinChannelIds',
  'summaryPrompt', 'overviewPrompt', 'keepAudio', 'botNickname',
];

// Free-text settings validateSetup stores as given; they must be strings.
const TEXT_CONFIG_FIELDS = ['model', 'fallbackModel', 'notesChannelId', 'sttModel', 'botNickname'];
const CONFIG_TEXT_MAX = 200;

/** Shape errors in a settings PATCH body that would otherwise reach SQLite. */
export function configInputError(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'Send the settings as a JSON object.';
  const bad = TEXT_CONFIG_FIELDS.find((field) => input[field] != null
    && (typeof input[field] !== 'string' || input[field].length > CONFIG_TEXT_MAX));
  return bad ? `${bad} must be text of at most ${CONFIG_TEXT_MAX} characters.` : null;
}

export const JOURNAL_CHANGED = 'The journal changed while you were editing (a session was folded in). Copy your text, reload, and re-apply your edits.';

/**
 * Why a journal edit can't be saved, as { status, body }, or null. `journalBase`
 * is the journal_updated_at the editor started from (omit it to skip the check).
 */
export function journalEditConflict(campaign, { journalBase } = {}) {
  if (journalBase !== undefined && journalBase !== null && typeof journalBase !== 'string') {
    return { status: 400, body: { error: 'journalBase must be a string or null.' } };
  }
  if (campaign.journal_status === 'updating') {
    return { status: 409, body: { error: 'The journal is being updated; try again when it finishes.' } };
  }
  if (journalBase !== undefined && journalBase !== campaign.journal_updated_at) {
    return { status: 409, body: { error: JOURNAL_CHANGED, campaign } };
  }
  return null;
}

/** The trimmed `question` of an ask request body ('' when missing or not text). */
export function questionOf(body) {
  return typeof body?.question === 'string' ? body.question.trim() : '';
}
