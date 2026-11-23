import { ChannelType } from 'discord.js';
import { guildBusyWith } from '../voice/decisions.js';

/**
 * Why /join can't start recording `channel` right now, as the reply text — or
 * null when it can. The bot fits in one voice channel per server, so a busy
 * guild names the channel already being recorded (or joined).
 */
export function joinRefusal({ channel, activeChannelId = null, joiningChannelId = null, accepting = true }) {
  if (!channel) return '❌ Join a voice channel first.';
  if (channel.type !== ChannelType.GuildVoice) {
    return "❌ Stage channels aren't supported — start /join from a regular voice channel.";
  }
  if (!accepting) return '⏳ The bot is restarting or shutting down — try again in a moment.';
  if (activeChannelId === channel.id) return '✅ Already recording this channel.';
  if (joiningChannelId === channel.id) return '⏳ Already joining this channel — recording starts in a moment.';
  const busy = guildBusyWith({ channelId: channel.id, activeChannelId, joiningChannelId });
  if (!busy) return null;
  const doing = activeChannelId ? 'recording' : 'joining';
  return `❌ I'm already ${doing} <#${busy}> in this server, and Discord lets me be in only one voice channel per server. Use /leave there first.`;
}

const JOIN_OUTCOME_REPLIES = {
  started: '✅ Recording started.',
  cancelled: '🛑 Recording was cancelled before it started (someone used /leave or stopped it from the dashboard).',
  busy: "⏳ I'm still joining or leaving a voice channel in this server — try again in a few seconds.",
};

/** Reply for what joinAndStart() did: 'started' | 'cancelled' | 'busy'. */
export function joinOutcomeReply(outcome) {
  return JOIN_OUTCOME_REPLIES[outcome] ?? JOIN_OUTCOME_REPLIES.started;
}
