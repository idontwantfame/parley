import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { resolveGuildMeeting, renderStatus } from '../src/commands/meeting-lookup.js';

function seed() {
  const db = openDb(':memory:');
  const mine = db.createMeeting({ guildId: 'X', channelId: 'c', channelName: 'Ours', startedAt: '2026-06-01T10:00:00Z' });
  const theirs = db.createMeeting({ guildId: 'Y', channelId: 'd', channelName: 'Secret', startedAt: '2026-06-01T11:00:00Z' });
  return { db, mine, theirs };
}

test('a meeting id from another guild is treated as not found (ids are sequential)', () => {
  const { db, theirs } = seed();
  assert.equal(resolveGuildMeeting(db, 'X', theirs), null);
});

test('a meeting id from this guild resolves', () => {
  const { db, mine } = seed();
  assert.equal(resolveGuildMeeting(db, 'X', mine).id, mine);
});

test('without an id, the guild\'s own most recent meeting is used', () => {
  const { db, mine } = seed();
  assert.equal(resolveGuildMeeting(db, 'X', null).id, mine);
  assert.equal(resolveGuildMeeting(db, 'Z', null), null);
});

test('an unknown id is not found', () => {
  const { db } = seed();
  assert.equal(resolveGuildMeeting(db, 'X', 9999), null);
});

test('/status lists only the current guild\'s live recordings', () => {
  const text = renderStatus({
    guildId: 'X',
    active: [
      { guildId: 'X', channelId: 'c1', meetingId: 1 },
      { guildId: 'Y', channelId: 'secret', meetingId: 2 },
    ],
    recent: [],
  });
  assert.match(text, /<#c1>/);
  assert.doesNotMatch(text, /secret|#2\b/);
});

test('/status reports idle when only other guilds are recording, and lists recent meetings', () => {
  const text = renderStatus({
    guildId: 'X',
    active: [{ guildId: 'Y', channelId: 'secret', meetingId: 2 }],
    recent: [{ id: 5, channel_name: 'Ours', started_at: '2026-06-01T10:00:00Z', status: 'done' }],
  });
  assert.match(text, /Not currently recording/);
  assert.match(text, /#5 • Ours/);
});
