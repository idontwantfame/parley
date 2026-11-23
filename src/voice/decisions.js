export const DEFAULT_AUTO_JOIN_MIN_PEOPLE = 2;

export function shouldAutoJoin({
  humanCount, autoJoin, connected, minPeople = DEFAULT_AUTO_JOIN_MIN_PEOPLE,
  channelId, allowedChannelIds = null, guildBusy = false,
}) {
  return !!autoJoin && !connected && !guildBusy && humanCount >= minPeople
    && (allowedChannelIds === null || allowedChannelIds.includes(channelId));
}

export function shouldAutoLeave({ humanCount, connected, minPeople = DEFAULT_AUTO_JOIN_MIN_PEOPLE }) {
  // Leave the last participant alone, unless recording solo was enabled.
  return !!connected && humanCount <= (minPeople === 1 ? 0 : 1);
}

// Discord lets a bot sit in ONE voice channel per guild, and @discordjs/voice
// keeps one connection per guild (joining channel B moves the existing
// connection out of A). So a guild records at most one meeting at a time.
// Returns the channel that blocks recording `channelId`, or null when free.
export function guildBusyWith({ channelId, activeChannelId = null, joiningChannelId = null }) {
  const busy = activeChannelId ?? joiningChannelId;
  return busy && busy !== channelId ? busy : null;
}

// The bot's own voice state changed: did someone (a moderator) drag it into a
// different channel than the one it is recording? Its audio would otherwise be
// filed under the wrong meeting. A plain disconnect (newChannelId null) is left
// to the connection's Disconnected recovery, which can tell blips from kicks.
export function botMovedAway({ activeChannelId, newChannelId }) {
  return !!activeChannelId && !!newChannelId && newChannelId !== activeChannelId;
}
