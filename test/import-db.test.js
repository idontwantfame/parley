// Storage for imported recordings: the meetings.source column, per-recording
// speakers and their renames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';

const STARTED = '2026-11-20T10:00:00.000Z';

function importWithSpeakers(db, guildId = 'g1') {
  const id = db.createImportedMeeting({ guildId, title: 'Board call', startedAt: STARTED });
  const speaker = `import-${id}-1`;
  db.addAttendee(id, speaker, 'Speaker 1');
  db.replaceUtterances(id, [{ userId: speaker, displayName: 'Speaker 1', startMs: 1, endMs: 2, text: 'hi' }], { complete: true });
  return { id, speaker };
}

test('createImportedMeeting files a processing meeting marked as an import', () => {
  const db = openDb(':memory:');
  const id = db.createImportedMeeting({ guildId: 'g1', title: 'Board call', startedAt: STARTED });
  const meeting = db.getMeeting(id);
  assert.equal(typeof id, 'number');
  assert.deepEqual(
    { guild: meeting.guild_id, channel: meeting.channel_id, name: meeting.channel_name, started: meeting.started_at,
      status: meeting.status, source: meeting.source, campaign: meeting.campaign_id, error: meeting.import_error },
    { guild: 'g1', channel: 'import', name: 'Board call', started: STARTED, status: 'processing', source: 'import',
      campaign: null, error: null });
});

test('Discord meetings keep a null source, and the meeting list exposes it', () => {
  const db = openDb(':memory:');
  const discord = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'Voice', startedAt: STARTED });
  const { id } = importWithSpeakers(db);
  assert.equal(db.getMeeting(discord).source, null);
  db.addUtterance({ meetingId: discord, userId: 'u', displayName: 'Al', startMs: 0, endMs: 1, text: 'x' });
  const listed = new Map(db.listRecentRich('g1', 10).map((m) => [m.id, m.source]));
  assert.equal(listed.get(id), 'import');
  assert.equal(listed.get(discord), null);
});

test('import failure reason and end time can be recorded', () => {
  const db = openDb(':memory:');
  const id = db.createImportedMeeting({ guildId: 'g1', title: 't', startedAt: STARTED });
  db.setImportError(id, 'ffmpeg is not installed');
  assert.equal(db.getMeeting(id).import_error, 'ffmpeg is not installed');
  db.setImportError(id, null);
  assert.equal(db.getMeeting(id).import_error, null);

  db.setMeetingEndedAt(id, '2026-11-20T11:00:00.000Z');
  db.setMeetingStatus(id, 'done', '2026-11-23T00:00:00.000Z');
  assert.equal(db.getMeeting(id).ended_at, '2026-11-20T11:00:00.000Z', 'the recording end wins over the pipeline finish');
});

test('renaming an imported speaker shows in its transcript and attendees', () => {
  const db = openDb(':memory:');
  const { id, speaker } = importWithSpeakers(db);
  db.setSpeakerName('g1', speaker, 'Alice');
  assert.equal(db.listUtterances(id)[0].display_name, 'Alice');
  assert.equal(db.listAttendees(id)[0].display_name, 'Alice');
});

test('the guild-wide speaker list leaves out per-recording import speakers', () => {
  const db = openDb(':memory:');
  const { speaker } = importWithSpeakers(db);
  db.setSpeakerName('g1', speaker, 'Alice');
  const discord = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'Voice', startedAt: STARTED });
  db.addAttendee(discord, '123456789012345678', 'Bob');
  assert.deepEqual(db.listGuildSpeakers('g1').map((s) => s.user_id), ['123456789012345678']);
});

test('deleting an import also forgets its speaker names, not other recordings\'', () => {
  const db = openDb(':memory:');
  const first = importWithSpeakers(db);
  const second = importWithSpeakers(db);
  db.setSpeakerName('g1', first.speaker, 'Alice');
  db.setSpeakerName('g1', second.speaker, 'Bob');
  db.setSpeakerName('g1', '123456789012345678', 'Carol');
  db.deleteMeeting(first.id);
  const names = db.sql.prepare('SELECT user_id FROM speaker_names ORDER BY user_id').all().map((r) => r.user_id);
  assert.deepEqual(names, ['123456789012345678', second.speaker]);
});

test('openDb adds the import columns to a db created before them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-migration-'));
  const path = join(dir, 'meetings.db');
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, channel_id TEXT,
      channel_name TEXT, started_at TEXT, ended_at TEXT, status TEXT NOT NULL DEFAULT 'recording');
      INSERT INTO meetings (guild_id, channel_id, channel_name, started_at, status) VALUES ('g','c','x','t','done');`);
    raw.close();
    const db = openDb(path);
    const meeting = db.getMeeting(1);
    assert.equal(meeting.source, null);
    assert.equal(meeting.import_error, null);
    db.sql.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
