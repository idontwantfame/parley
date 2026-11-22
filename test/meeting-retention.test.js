import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { pruneMeetings } from '../src/store/meeting-retention.js';

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
