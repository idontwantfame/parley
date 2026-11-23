import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
import { CLIENT_OPTIONS } from '../src/bot.js';

// LLM output, transcripts and error text are posted verbatim; none of it may
// ping @everyone/@here, roles or users. Set once as the client default so every
// send/reply/followUp inherits it.
test('the Discord client suppresses all mentions by default', () => {
  assert.deepEqual(CLIENT_OPTIONS.allowedMentions, { parse: [] });
});

test('the client keeps the minimal, non-privileged gateway intents', () => {
  assert.deepEqual(CLIENT_OPTIONS.intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]);
});
