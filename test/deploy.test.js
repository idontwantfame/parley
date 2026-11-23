import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restFor } from '../src/commands/deploy.js';

// Each @discordjs/rest REST starts sweeper intervals that are never cleared, so
// building one per call (per guild, per start, per guildCreate) leaked them all.
test('the REST client is reused per token', () => {
  assert.equal(restFor('token-a'), restFor('token-a'));
});

test('a new token replaces the client and stops the old one\'s sweepers', () => {
  const first = restFor('token-b');
  let cleared = 0;
  first.clearHashSweeper = () => { cleared++; };
  first.clearHandlerSweeper = () => { cleared++; };
  const second = restFor('token-c');
  assert.notEqual(second, first);
  assert.equal(cleared, 2);
});

import { deployCommands, clearGlobalCommands } from '../src/commands/deploy.js';

test('deploy and clear go through the shared client with the right routes', async () => {
  const puts = [];
  const rest = restFor('token-d');
  rest.put = async (route, { body }) => { puts.push([route, body.length]); };
  await deployCommands('app', 'token-d', 'guild-1');
  await clearGlobalCommands('app', 'token-d');
  assert.equal(puts[0][0], '/applications/app/guilds/guild-1/commands');
  assert.ok(puts[0][1] > 0);
  assert.deepEqual(puts[1], ['/applications/app/commands', 0]);
});
