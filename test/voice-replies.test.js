import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { joinRefusal } from '../src/commands/voice-replies.js';

const voice = (id) => ({ id, type: ChannelType.GuildVoice });

test('/join needs the member in a voice channel', () => {
  assert.match(joinRefusal({ channel: null }), /Join a voice channel first/);
});

test('/join refuses stage channels with a clear message', () => {
  assert.match(joinRefusal({ channel: { id: 's', type: ChannelType.GuildStageVoice } }), /Stage channels/i);
});

test('/join from another channel names the channel already being recorded', () => {
  const msg = joinRefusal({ channel: voice('B'), activeChannelId: 'A' });
  assert.match(msg, /<#A>/);
  assert.match(msg, /one voice channel per server/i);
});

test('/join while another channel is still joining names that channel', () => {
  assert.match(joinRefusal({ channel: voice('B'), joiningChannelId: 'A' }), /<#A>/);
});

test('/join in the channel already recorded or joining is acknowledged, not repeated', () => {
  assert.match(joinRefusal({ channel: voice('A'), activeChannelId: 'A' }), /Already recording this channel/);
  assert.match(joinRefusal({ channel: voice('A'), joiningChannelId: 'A' }), /Already joining/);
});

test('/join while the bot is shutting down is refused', () => {
  assert.match(joinRefusal({ channel: voice('A'), accepting: false }), /restarting|shutting down/i);
});

test('/join in a free guild is allowed', () => {
  assert.equal(joinRefusal({ channel: voice('A') }), null);
});

import { joinOutcomeReply } from '../src/commands/voice-replies.js';

test('/join reports a recording cancelled by /leave during the join window', () => {
  assert.match(joinOutcomeReply('started'), /Recording started/);
  assert.match(joinOutcomeReply('cancelled'), /cancelled/i);
  assert.match(joinOutcomeReply('busy'), /joining or leaving.*try again/i);
});
