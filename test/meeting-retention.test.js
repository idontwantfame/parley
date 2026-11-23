import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { pruneMeetings, removeMeetingArtifacts } from '../src/store/meeting-retention.js';

test('retention previews, then removes expired non-campaign meetings and their files', async (t) => {
  const db = openDb(':memory:');
  const dataDir = await mkdtemp(join(tmpdir(), 'parley-retention-'));
  t.after(() => { db.sql.close(); return rm(dataDir, { recursive: true, force: true }); });
  const create = (startedAt, status) => {
    const id = db.createMeeting({ startedAt, guildId: 'g1', channelId: 'voice', channelName: 'Voice' });
    db.setMeetingStatus(id, status, startedAt);
    return id;
  };
  const old = '2025-01-01T00:00:00Z';
  const expired = create(old, 'done');
  const active = create(old, 'processing');
  const campaignMeeting = create(old, 'done');
  const recent = create('2025-03-31T00:00:00Z', 'done');
  db.setMeetingCampaign(campaignMeeting, db.createCampaign({ guildId: 'g1', name: 'Campaign' }));
  const exportDir = join(dataDir, 'exports');
  await mkdir(exportDir);
  await writeFile(join(exportDir, `meeting-${expired}-2025-01-01.md`), 'notes');
  await mkdir(join(dataDir, 'audio', String(expired)), { recursive: true });
  const opts = { now: Date.parse('2025-04-01T00:00:00Z'), dataDir, exportDir };
  assert.deepEqual(await pruneMeetings(db, 30, opts), { eligible: 1, deleted: 0 });
  assert.ok(db.getMeeting(expired));
  assert.deepEqual(await pruneMeetings(db, 30, { ...opts, dryRun: false }), { eligible: 1, deleted: 1, cleanupErrors: 0 });
  assert.equal(db.getMeeting(expired), undefined);
  for (const id of [active, campaignMeeting, recent]) assert.ok(db.getMeeting(id));
  assert.deepEqual(await readdir(exportDir), []);
  assert.deepEqual(await readdir(join(dataDir, 'audio')), []);
});

test('retention also removes old failed and empty meetings with their audio, never in-progress ones', async (t) => {
  const db = openDb(':memory:');
  const dataDir = await mkdtemp(join(tmpdir(), 'parley-retention-failed-'));
  t.after(() => { db.sql.close(); return rm(dataDir, { recursive: true, force: true }); });
  const old = '2025-01-01T00:00:00Z';
  const create = (status) => {
    const id = db.createMeeting({ startedAt: old, guildId: 'g1', channelId: 'voice', channelName: 'Voice' });
    db.setMeetingStatus(id, status, old);
    return id;
  };
  const expired = ['transcription_failed', 'summary_failed', 'empty'].map(create);
  const kept = ['recording', 'processing'].map(create);
  for (const id of [...expired, ...kept]) {
    await mkdir(join(dataDir, 'audio', String(id)), { recursive: true });
    await writeFile(join(dataDir, 'audio', String(id), 'u_1.pcm'), 'pcm');
  }
  const exportDir = join(dataDir, 'exports');
  const result = await pruneMeetings(db, 30, { now: Date.parse('2025-04-01T00:00:00Z'), dataDir, exportDir, dryRun: false });
  assert.deepEqual(result, { eligible: 3, deleted: 3, cleanupErrors: 0 });
  for (const id of expired) assert.equal(db.getMeeting(id), undefined);
  for (const id of kept) assert.ok(db.getMeeting(id));
  assert.deepEqual((await readdir(join(dataDir, 'audio'))).sort(), kept.map(String).sort());
});

test('removeMeetingArtifacts deletes the audio folder and both export files', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'parley-artifacts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const exportDir = join(dataDir, 'exports');
  const meeting = { id: 7, started_at: '2025-02-03T04:05:06Z' };
  await mkdir(join(dataDir, 'audio', '7'), { recursive: true });
  await mkdir(exportDir);
  await writeFile(join(exportDir, 'meeting-7-2025-02-03.md'), 'notes');
  await writeFile(join(exportDir, 'meeting-7-2025-02-03.json'), '{}');
  await writeFile(join(exportDir, 'meeting-8-2025-02-03.md'), 'other');
  assert.equal(await removeMeetingArtifacts(meeting, { dataDir, exportDir }), 0);
  assert.deepEqual(await readdir(exportDir), ['meeting-8-2025-02-03.md']);
  assert.deepEqual(await readdir(join(dataDir, 'audio')), []);
});
