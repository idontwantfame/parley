import { ChannelType } from 'discord.js';
import { renderNotesChunks } from './discord-notes.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { config } from '../config/env.js';

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
      .create({ name: `Notes — ${meeting.channel_name} ${meeting.started_at.slice(0, 10)}` })
      .catch(() => channel);
  }
  if (link) {
    const label = language === 'pl' ? 'Pełne notatki w Parley' : 'Full notes in Parley';
    parts.push(`[${label}](<${link}>)`);
  }
  let sent = 0;
  try {
    for (const content of parts) {
      await target.send({ content, allowedMentions: { parse: [] } });
      sent++;
    }
  } catch (error) {
    if (!sent) throw error;
    throw new Error(`Discord received ${sent} of ${parts.length} messages. Check the channel before posting again. ${error.message}`, { cause: error });
  }
}
