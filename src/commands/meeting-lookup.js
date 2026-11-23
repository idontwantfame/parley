// Guild-scoped meeting lookups for slash commands. Meeting ids are sequential,
// so a command must never resolve another server's meeting from a typed id.

/** The meeting `requestedId` (or this guild's latest) — null unless it belongs to guildId. */
export function resolveGuildMeeting(db, guildId, requestedId) {
  const id = requestedId ?? db.listRecent(guildId, 1)[0]?.id;
  if (!id) return null;
  const meeting = db.getMeeting(id);
  return meeting && meeting.guild_id === guildId ? meeting : null;
}

const meetingLine = (m) => `#${m.id} • ${m.channel_name} • ${m.started_at} • ${m.status}`;

/** /status text: this guild's live recording(s) plus its recent meetings. */
export function renderStatus({ guildId, active, recent }) {
  const live = active.filter((s) => s.guildId === guildId);
  const activeText = live.length
    ? live.map((s) => `🔴 Recording in <#${s.channelId}> (meeting #${s.meetingId})`).join('\n')
    : '🟢 Not currently recording.';
  const recentText = recent.length ? `\n\n**Recent meetings:**\n${recent.map(meetingLine).join('\n')}` : '';
  return activeText + recentText;
}

export function renderHistory(rows) {
  return rows.length ? rows.map(meetingLine).join('\n') : 'No meetings yet.';
}
