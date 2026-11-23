// src/delivery/discord-safe.js
// Text that came from a model or a transcript is posted to Discord as data,
// never as a trap: a masked link "[label](url)" shows its real destination,
// and link previews (embeds) are suppressed. Mentions are already off for the
// whole client (allowedMentions: { parse: [] } in bot.js).
import { MessageFlags } from 'discord.js';

/** Message options for anything Parley posts from model/transcript text. */
export const QUIET_MESSAGE = Object.freeze({ flags: MessageFlags.SuppressEmbeds, allowedMentions: Object.freeze({ parse: [] }) });

// [label](url), [label](<url>) or [label](url "title"); the label may hold one
// level of [brackets].
const MASKED_LINK = /\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** "[label](url)" → "label (url)", so the destination is visible. */
export function neutralizeMaskedLinks(text) {
  return String(text ?? '').replace(MASKED_LINK, (_match, label, url) => (label.trim() ? `${label} (${url})` : url));
}
