import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingVoicePermission, JOIN_READY_TIMEOUT_MS } from '../src/voice/connect.js';

const channelWith = (granted) => ({
  guild: { members: { me: { permissionsIn: () => ({ has: (p) => granted.includes(p) }) } } },
});

test('the join handshake is bounded', () => {
  assert.equal(JOIN_READY_TIMEOUT_MS, 25_000);
});

test('missingVoicePermission names the first missing voice permission', () => {
  assert.equal(missingVoicePermission(channelWith(['Connect', 'Speak'])), null);
  assert.equal(missingVoicePermission(channelWith(['Speak'])), 'Connect');
  assert.equal(missingVoicePermission(channelWith(['Connect'])), 'Speak');
  assert.equal(missingVoicePermission({ guild: { members: { me: null } } }), 'Connect');
});

import { connectToChannel } from '../src/voice/connect.js';

test('connectToChannel refuses before joining when a permission is missing', async () => {
  await assert.rejects(
    connectToChannel({ id: 'c', ...channelWith(['Connect']) }, { botUser: {} }),
    /lacks \*\*Speak\*\* permission/,
  );
});
