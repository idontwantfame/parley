import { ChannelType } from 'discord.js';
import { renderNotesChunks } from './discord-notes.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { config } from '../config/env.js';
import { QUIET_MESSAGE } from './discord-safe.js';

function meetingLink(base, id) {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/meetings/${id}`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// Discord rejects thread names over 100 characters (and the post would then
// silently land in the channel instead). Trim the channel name, never the date,
// and never split a surrogate pair.
export const THREAD_NAME_LIMIT = 100;
const THREAD_PREFIX = 'Notes — ';

export function notesThreadName(channelName, startedAt) {
  const suffix = /^\d{4}-\d{2}-\d{2}/.test(startedAt || '') ? ` ${startedAt.slice(0, 10)}` : '';
  const room = THREAD_NAME_LIMIT - THREAD_PREFIX.length - suffix.length;
  const name = channelName || 'meeting';
  if (name.length <= room) return `${THREAD_PREFIX}${name}${suffix}`;
  let trimmed = '';
  for (const char of name) {
    if (trimmed.length + char.length > room - 1) break;
    trimmed += char;
  }
  return `${THREAD_PREFIX}${trimmed}…${suffix}`;
}

export async function postNotes({ client, meeting, cfg, notes, talktime }) {
  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  // Throw rather than silently dropping the notes: the pipeline records this as
  // a delivery failure (the meeting is still 'done' with notes in the dashboard)
  // instead of pretending the post succeeded with no trace.
  if (!channel) throw new Error(`Notes channel ${channelId} is unreachable (deleted or missing access).`);
  if (meeting.guild_id && channel.guildId !== meeting.guild_id) {
    throw new Error('The configured notes channel belongs to a different Discord server.');
  }

  const language = resolveSummaryLanguage(cfg);
  const link = meetingLink(config.notesBaseUrl, meeting.id);
  const parts = renderNotesChunks(link ? { tldr: notes.tldr } : notes, link ? [] : talktime, {
    channelName: meeting.channel_name,
    date: meeting.started_at,
    endedAt: meeting.ended_at,
    summaryLanguage: language,
  });

  let target = channel;
  if (cfg.useThread && channel.type === ChannelType.GuildText) {
    // Fall back to the channel itself if thread creation fails (e.g. missing perms)
    // so the notes are never silently lost.
    target = await channel.threads
      .create({ name: notesThreadName(meeting.channel_name, meeting.started_at) })
      .catch(() => channel);
  }
  if (link) {
    const label = language === 'pl' ? 'Pełne notatki w Parley' : 'Full notes in Parley';
    parts.push(`[${label}](<${link}>)`);
  }
  let sent = 0;
  try {
    for (const content of parts) {
      await target.send({ content, ...QUIET_MESSAGE });
      sent++;
    }
  } catch (error) {
    if (!sent) throw error;
    throw new Error(`Discord received ${sent} of ${parts.length} messages. Check the channel before posting again. ${error.message}`, { cause: error });
  }
}
