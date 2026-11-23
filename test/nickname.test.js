import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nicknameFor, parseBotName, BOT_NAME_MAX } from '../src/voice/nickname.js';

test('a custom bot name is the idle nickname and gets the [REC] prefix while recording', () => {
  assert.equal(nicknameFor({ name: 'Scribe', recording: false }, '[REC] Meeting Bot'), 'Scribe');
  assert.equal(nicknameFor({ name: 'Scribe', recording: true }, '[REC] Meeting Bot'), '[REC] Scribe');
});

test('without a custom name the bot keeps today\'s behaviour', () => {
  // Idle: null resets the nickname to the Discord account name.
  assert.equal(nicknameFor({ name: null, recording: false }, '[REC] Meeting Bot'), null);
  // Recording: the configured (env) recording nickname.
  assert.equal(nicknameFor({ name: null, recording: true }, '[REC] Notes'), '[REC] Notes');
});

test('the longest allowed name still fits Discord\'s 32-character nickname limit while recording', () => {
  const name = 'x'.repeat(BOT_NAME_MAX);
  assert.equal(Array.from(nicknameFor({ name, recording: true }, 'unused')).length, 32);
});

test('parseBotName trims, clears on empty, and rejects bad names', () => {
  assert.deepEqual(parseBotName('  Scribe  '), { ok: true, value: 'Scribe' });
  assert.deepEqual(parseBotName(''), { ok: true, value: null });
  assert.deepEqual(parseBotName('   '), { ok: true, value: null });
  assert.deepEqual(parseBotName(null), { ok: true, value: null });
  // Counted in characters (code points), not UTF-16 units.
  assert.equal(parseBotName('🎙'.repeat(BOT_NAME_MAX)).ok, true);
  assert.equal(parseBotName('x'.repeat(BOT_NAME_MAX + 1)).ok, false);
  assert.equal(parseBotName('bad\nname').ok, false);
  assert.equal(parseBotName(42).ok, false);
});
