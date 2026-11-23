// test/api-contract.test.js — response shapes the dashboard relies on:
// meeting list paging, meeting detail extras, journal edit conflicts,
// background retry and campaign "unassigned" sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { apiRouter } from '../src/web/api.js';
import { config as env } from '../src/config/env.js';

async function serve(t, db) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return (method, path, body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function meeting(db, { guildId = 'g1', status = 'done', utterances = 1 } = {}) {
  const id = Number(db.createMeeting({ guildId, channelId: 'c', channelName: 'Voice', startedAt: `2026-01-0${1 + (utterances % 9)}T00:00:00Z` }));
  db.setMeetingStatus(id, status);
  for (let i = 0; i < utterances; i++) db.addUtterance({ meetingId: id, userId: 'u', displayName: 'Al', startMs: i, endMs: i + 1, text: 'hi' });
  return id;
}

test('GET meetings pages with limit and before, and validates both', async (t) => {
  const db = openDb(':memory:');
  const ids = Array.from({ length: 5 }, () => meeting(db));
  const call = await serve(t, db);
  const page = async (query) => (await (await call('GET', `/guilds/g1/meetings${query}`)).json()).map((m) => m.id);
  assert.deepEqual(await page(''), [...ids].reverse());
  assert.deepEqual(await page('?limit=2'), [ids[4], ids[3]]);
  assert.deepEqual(await page(`?limit=2&before=${ids[3]}`), [ids[2], ids[1]]);
  for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?limit=1.5', '?before=-1', '?before=x', '?limit=1&limit=2']) {
    assert.equal((await call('GET', `/guilds/g1/meetings${query}`)).status, 400, query);
  }
});

test('GET meeting detail includes its todos and list neighbours', async (t) => {
  const db = openDb(':memory:');
  const older = meeting(db);
  meeting(db, { utterances: 0 }); // hidden from the list → skipped
  const id = meeting(db);
  meeting(db, { guildId: 'g2' });
  db.seedTodos(id, 'g1', [{ assignee: 'Al', task: 'ship' }]);
  const call = await serve(t, db);
  const bundle = await (await call('GET', `/meetings/${id}`)).json();
  assert.deepEqual(bundle.todos.map((todo) => todo.task), ['ship']);
  assert.deepEqual(Object.keys(bundle.todos[0]).sort(), Object.keys(db.listTodos('g1')[0]).sort());
  assert.deepEqual(bundle.neighbors, { older: { id: older, started_at: db.getMeeting(older).started_at }, newer: null });
  assert.equal(bundle.utterances.length, 1);
  assert.equal(bundle.retry.eligible, false);
  assert.equal(bundle.regenerate.eligible, true);
});

test('journal edits conflict when the journal changed since the editor loaded it', async (t) => {
  const db = openDb(':memory:');
  const id = db.createCampaign({ guildId: 'g1', name: 'C' });
  db.setCampaignJournal(id, 'v1');
  const loaded = db.getCampaign(id).journal_updated_at;
  const call = await serve(t, db);

  await new Promise((r) => setTimeout(r, 5));
  db.setCampaignJournal(id, 'v2 (folded)');
  const stale = await call('PATCH', `/campaigns/${id}`, { journal: 'mine', journalBase: loaded, name: 'Renamed' });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.match(body.error, /journal changed while you were editing/);
  assert.equal(body.campaign.journal, 'v2 (folded)');
  assert.equal(db.getCampaign(id).name, 'C'); // nothing applied

  const fresh = await call('PATCH', `/campaigns/${id}`, { journal: 'mine', journalBase: db.getCampaign(id).journal_updated_at });
  assert.equal(fresh.status, 200);
  assert.equal(db.getCampaign(id).journal, 'mine');
  assert.equal((await call('PATCH', `/campaigns/${id}`, { journal: 'legacy client' })).status, 200);
  assert.equal((await call('PATCH', `/campaigns/${id}`, { journal: 'x', journalBase: 5 })).status, 400);

  const empty = db.createCampaign({ guildId: 'g1', name: 'Fresh' });
  assert.equal((await call('PATCH', `/campaigns/${empty}`, { journal: 'first', journalBase: null })).status, 200);
});

test('retry starts in the background and reports progress', async (t) => {
  const previous = env.autoExport;
  env.autoExport = false;
  t.after(() => { env.autoExport = previous; });
  const db = openDb(':memory:');
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', 'fake')`).run();
  const id = meeting(db, { status: 'summary_failed' });
  const call = await serve(t, db);
  const res = await call('POST', `/meetings/${id}/retry`);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, started: true });
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    const progress = await (await call('GET', `/meetings/${id}/progress`)).json();
    status = progress.status;
    if (!progress.progress && status === 'done') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status, 'done');
  assert.equal((await call('POST', '/meetings/9999/retry')).status, 404);
  assert.equal((await call('POST', `/meetings/${id}/retry`)).status, 409); // done now
  const lost = meeting(db, { status: 'transcription_failed', utterances: 0 });
  assert.equal((await call('POST', `/meetings/${lost}/retry`)).status, 409); // no transcript, no audio
});

test('campaign detail lists unassigned meetings beyond the recent window', async (t) => {
  const db = openDb(':memory:');
  const campaign = db.createCampaign({ guildId: 'g1', name: 'C' });
  const old = meeting(db);
  for (let i = 0; i < 205; i++) db.setMeetingCampaign(meeting(db), campaign);
  const call = await serve(t, db);
  const body = await (await call('GET', `/campaigns/${campaign}`)).json();
  assert.deepEqual(body.unassigned.map((m) => m.id), [old]);
  assert.deepEqual(Object.keys(body.unassigned[0]).sort(), ['channel_name', 'id', 'started_at', 'status', 'tldr']);
  assert.equal('sections' in body, false);
});

test('a second retry request while the first is running is refused', async (t) => {
  const previous = env.autoExport;
  env.autoExport = false;
  t.after(() => { env.autoExport = previous; });
  const db = openDb(':memory:');
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', 'fake')`).run();
  const id = meeting(db, { status: 'summary_failed' });
  const call = await serve(t, db);
  const [first, second] = await Promise.all([call('POST', `/meetings/${id}/retry`), call('POST', `/meetings/${id}/retry`)]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409]);
  for (let attempt = 0; attempt < 50 && db.getMeeting(id).status !== 'done'; attempt++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(db.getMeeting(id).status, 'done');
});
