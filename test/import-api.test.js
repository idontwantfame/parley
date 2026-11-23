// Existing dashboard routes with imported recordings: speaker renames, the
// Settings speaker list, delivery target, campaign channel picker and retry.
import { config } from '../src/config/env.js';
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { apiRouter } from '../src/web/api.js';

async function withApi(db, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/api`); } finally { server.close(); }
}

function importedMeeting(db) {
  const id = db.createImportedMeeting({ guildId: 'g1', title: 'Board call', startedAt: '2026-11-20T10:00:00.000Z' });
  const speaker = `import-${id}-1`;
  db.addAttendee(id, speaker, 'Speaker 1');
  db.replaceUtterances(id, [{ userId: speaker, displayName: 'Speaker 1', startMs: 1, endMs: 2, text: 'hi' }], { complete: true });
  return { id, speaker };
}

const putName = (base, userId, name) => fetch(`${base}/guilds/g1/speaker-names/${userId}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
});

test('imported speakers can be renamed, and the rename shows in the meeting', async () => {
  const db = openDb(':memory:');
  const { id, speaker } = importedMeeting(db);
  await withApi(db, async (base) => {
    const res = await putName(base, speaker, 'Alice');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'Alice' });
    const detail = await (await fetch(`${base}/meetings/${id}`)).json();
    assert.equal(detail.utterances[0].display_name, 'Alice');
    assert.equal(detail.attendees[0].display_name, 'Alice');
    assert.equal((await putName(base, speaker, '')).status, 200);
    assert.equal(db.listUtterances(id)[0].display_name, 'Speaker 1');
  });
});

test('speaker ids must be Discord user ids or import speaker ids', async () => {
  const db = openDb(':memory:');
  await withApi(db, async (base) => {
    for (const bad of ['import-5', 'import-a-1', 'import-5-1x', 'import--1', 'imports-5-1', '12345']) {
      assert.equal((await putName(base, bad, 'X')).status, 400, bad);
    }
    assert.equal((await putName(base, '123456789012345678', 'Bob')).status, 200);
  });
});

test('the Settings speaker list leaves out per-recording import speakers', async () => {
  const db = openDb(':memory:');
  const { speaker } = importedMeeting(db);
  db.setSpeakerName('g1', speaker, 'Alice');
  const discord = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'Voice', startedAt: 't' });
  db.addAttendee(discord, '123456789012345678', 'Bob');
  await withApi(db, async (base) => {
    const list = await (await fetch(`${base}/guilds/g1/speaker-names`)).json();
    assert.deepEqual(list.map((s) => s.user_id), ['123456789012345678']);
  });
});

test('an import is delivered only to the configured notes channel', async () => {
  const db = openDb(':memory:');
  const { id } = importedMeeting(db);
  db.setMeetingStatus(id, 'done');
  await withApi(db, async (base) => {
    assert.equal((await (await fetch(`${base}/meetings/${id}`)).json()).deliveryTarget, null);
    setGuildConfig(db, 'g1', { notesChannelId: '42' });
    assert.deepEqual((await (await fetch(`${base}/meetings/${id}`)).json()).deliveryTarget, { id: '42', name: null });
  });
});

test('imports never appear as a voice channel in the campaign channel picker', async () => {
  const db = openDb(':memory:');
  importedMeeting(db);
  db.createMeeting({ guildId: 'g1', channelId: 'v1', channelName: 'Voice', startedAt: 't' });
  await withApi(db, async (base) => {
    const channels = await (await fetch(`${base}/guilds/g1/voice-channels`)).json();
    assert.deepEqual(channels.map((c) => c.id), ['v1']);
  });
});

test('a failed import without a transcript explains that it must be re-imported', async () => {
  const db = openDb(':memory:');
  const id = db.createImportedMeeting({ guildId: 'g1', title: 'Clip', startedAt: '2026-11-20T10:00:00.000Z' });
  db.setMeetingStatus(id, 'transcription_failed');
  await withApi(db, async (base) => {
    const detail = await (await fetch(`${base}/meetings/${id}`)).json();
    assert.deepEqual(detail.retry, { eligible: false, action: 'none', reason: 'Re-import the recording to retry transcription.' });
    const res = await fetch(`${base}/meetings/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'Re-import the recording to retry transcription.');
  });
});

test('deleting an import removes its recording folder and speaker names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-delete-'));
  const saved = { dataDir: config.dataDir, exportDir: config.exportDir };
  Object.assign(config, { dataDir: dir, exportDir: join(dir, 'exports') });
  try {
    const db = openDb(':memory:');
    const { id, speaker } = importedMeeting(db);
    db.setMeetingStatus(id, 'done');
    db.setSpeakerName('g1', speaker, 'Alice');
    mkdirSync(join(dir, 'audio', String(id)), { recursive: true });
    writeFileSync(join(dir, 'audio', String(id), 'mixed.mp3'), 'mp3');
    await withApi(db, async (base) => {
      assert.equal((await fetch(`${base}/meetings/${id}`, { method: 'DELETE' })).status, 200);
    });
    assert.equal(existsSync(join(dir, 'audio', String(id))), false);
    assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM speaker_names').get().n, 0);
  } finally {
    Object.assign(config, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
