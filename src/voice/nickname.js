// The bot's per-server display name (its Discord nickname). A custom name is
// shown while idle and gets a visible "[REC] " prefix while recording, so
// members can always tell a recording is in progress.

export const REC_PREFIX = '[REC] ';
// Discord nicknames are at most 32 characters; leave room for the prefix.
export const NICKNAME_MAX = 32;
export const BOT_NAME_MAX = NICKNAME_MAX - REC_PREFIX.length;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The nickname to set for a guild. `null` resets it to the Discord account
 * name. Without a custom name the recording nickname falls back to
 * `recordingDefault` (DISCORD_RECORDING_NICKNAME), as before.
 */
export function nicknameFor({ name, recording }, recordingDefault) {
  if (recording) return name ? `${REC_PREFIX}${name}` : recordingDefault;
  return name || null;
}

/** Validate a bot name from the UI or /setup: trimmed text, or null to clear. */
export function parseBotName(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Bot name must be text.' };
  const name = value.trim();
  if (!name) return { ok: true, value: null };
  if (Array.from(name).length > BOT_NAME_MAX || CONTROL_CHARS.test(name)) {
    return {
      ok: false,
      error: `Bot name must be at most ${BOT_NAME_MAX} characters on one line (Discord allows 32, including "${REC_PREFIX.trim()} " while recording).`,
    };
  }
  return { ok: true, value: name };
}
