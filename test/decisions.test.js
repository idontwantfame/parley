import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoJoin, shouldAutoLeave } from '../src/voice/decisions.js';

test('shouldAutoJoin true when >1 human and autoJoin enabled and not connected', () => {
  assert.equal(shouldAutoJoin({ humanCount: 2, autoJoin: true, connected: false }), true);
});

test('shouldAutoJoin false when autoJoin disabled', () => {
  assert.equal(shouldAutoJoin({ humanCount: 5, autoJoin: false, connected: false }), false);
});

test('shouldAutoJoin false when already connected', () => {
  assert.equal(shouldAutoJoin({ humanCount: 5, autoJoin: true, connected: true }), false);
});

test('shouldAutoJoin false when <=1 human', () => {
  assert.equal(shouldAutoJoin({ humanCount: 1, autoJoin: true, connected: false }), false);
});

test('shouldAutoJoin uses the configured number of humans', () => {
  const options = { autoJoin: true, connected: false, minPeople: 4 };
  assert.equal(shouldAutoJoin({ ...options, humanCount: 3 }), false);
  assert.equal(shouldAutoJoin({ ...options, humanCount: 4 }), true);
});

test('shouldAutoJoin honors the selected channels, including an empty selection', () => {
  const options = { autoJoin: true, connected: false, humanCount: 2, allowedChannelIds: ['a'] };
  assert.equal(shouldAutoJoin({ ...options, channelId: 'a' }), true);
  assert.equal(shouldAutoJoin({ ...options, channelId: 'b' }), false);
  assert.equal(shouldAutoJoin({ ...options, channelId: 'a', allowedChannelIds: [] }), false);
  assert.equal(shouldAutoJoin({ ...options, channelId: 'b', allowedChannelIds: null }), true);
});

test('a threshold of one permits recording until the voice channel empties', () => {
  const options = { autoJoin: true, connected: false, minPeople: 1 };
  assert.equal(shouldAutoJoin({ ...options, humanCount: 0 }), false);
  assert.equal(shouldAutoJoin({ ...options, humanCount: 1 }), true);
  assert.equal(shouldAutoLeave({ connected: true, minPeople: 1, humanCount: 1 }), false);
  assert.equal(shouldAutoLeave({ connected: true, minPeople: 1, humanCount: 0 }), true);
});

test('raising the start threshold preserves the existing automatic stop behavior', () => {
  assert.equal(shouldAutoLeave({ connected: true, minPeople: 4, humanCount: 2 }), false);
  assert.equal(shouldAutoLeave({ connected: true, minPeople: 4, humanCount: 1 }), true);
});

test('shouldAutoLeave true when connected and <=1 human', () => {
  assert.equal(shouldAutoLeave({ humanCount: 1, connected: true }), true);
  assert.equal(shouldAutoLeave({ humanCount: 2, connected: true }), false);
  assert.equal(shouldAutoLeave({ humanCount: 0, connected: false }), false);
});

// ── one meeting per guild (Discord + @discordjs/voice: one voice connection per guild) ──
import { guildBusyWith, botMovedAway } from '../src/voice/decisions.js';

test('guildBusyWith names the other channel being recorded or joined in the same guild', () => {
  assert.equal(guildBusyWith({ channelId: 'B', activeChannelId: 'A' }), 'A');
  assert.equal(guildBusyWith({ channelId: 'B', joiningChannelId: 'A' }), 'A');
  assert.equal(guildBusyWith({ channelId: 'A', activeChannelId: 'A' }), null);
  assert.equal(guildBusyWith({ channelId: 'A', joiningChannelId: 'A' }), null);
  assert.equal(guildBusyWith({ channelId: 'A' }), null);
});

test('shouldAutoJoin skips a channel while another channel in the guild is busy', () => {
  const options = { humanCount: 3, autoJoin: true, connected: false, channelId: 'B' };
  assert.equal(shouldAutoJoin({ ...options, guildBusy: true }), false);
  assert.equal(shouldAutoJoin({ ...options, guildBusy: false }), true);
});

test('botMovedAway is true only when the bot lands in a different channel than the one it records', () => {
  assert.equal(botMovedAway({ activeChannelId: 'A', newChannelId: 'B' }), true);
  assert.equal(botMovedAway({ activeChannelId: 'A', newChannelId: 'A' }), false);
  // A plain disconnect is handled by the connection's Disconnected recovery.
  assert.equal(botMovedAway({ activeChannelId: 'A', newChannelId: null }), false);
  assert.equal(botMovedAway({ activeChannelId: null, newChannelId: 'B' }), false);
});
