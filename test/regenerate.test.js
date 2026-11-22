// test/regenerate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { regeneratePlan, regenerateSummary } from '../src/pipeline/retry.js';
import { apiRouter } from '../src/web/api.js';

// A finished meeting with a transcript, an old summary and two seeded todos
// (one already ticked off). The guild uses the fake summarizer, whose canned
// notes contain the action item { assignee: 'Alice', task: 'do thing' }.
function seedDone({ provider = 'fake' } = {}) {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: '2026-11-01T10:00:00Z' });
  db.addAttendee(id, 'u', 'Alice');
  db.addUtterance({ meetingId: id, userId: 'u', displayName: 'Alice', startMs: 0, endMs: 5000, text: 'I will do the thing' });
  const old = { tldr: 'Old summary.', topics: [], decisions: [], openQuestions: [],
    actionItems: [{ assignee: 'Alice', task: 'do thing' }, { assignee: 'Bob', task: 'stale task' }] };
  db.saveSummary(id, old, [], 'old:model');
  db.seedTodos(id, 'g1', old.actionItems, '2026-11-01T10:00:00Z');
  for (const t of db.listTodos('g1')) db.setTodoDone(t.id, true);
  db.setMeetingStatus(id, 'done', '2026-11-01T11:00:00Z');
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', ?)`).run(provider);
  return { db, id };
}

test('regeneratePlan: only completed meetings with a transcript are eligible', () => {
  const { db, id } = seedDone();
  assert.equal(regeneratePlan(db, id).ok, true);

  db.setMeetingStatus(id, 'summary_failed');
  assert.equal(regeneratePlan(db, id).ok, false);
  db.setMeetingStatus(id, 'processing');
  assert.match(regeneratePlan(db, id).reason, /still being recorded or processed/);

  const empty = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });
  db.setMeetingStatus(empty, 'done');
  assert.match(regeneratePlan(db, empty).reason, /no transcript/);

  assert.equal(regeneratePlan(db, 9999).ok, false);
});

test('regenerateSummary replaces notes and todos, keeping done state for surviving items', async () => {
  const { db, id } = seedDone();
  const result = await regenerateSummary(db, id);
  assert.equal(result.ok, true);

  const summary = db.getSummary(id);
  assert.equal(summary.notes.tldr, 'Fake summary.');
  assert.equal(summary.talktime[0].displayName, 'Alice');
  assert.equal(db.getMeeting(id).status, 'done');

  const todos = db.listTodos('g1');
  assert.deepEqual(todos.map((t) => [t.assignee, t.task, t.done]), [['Alice', 'do thing', 1]],
    'stale item dropped; surviving item stays checked');
  assert.equal(todos[0].created_at, '2026-11-01T10:00:00Z');
});

test('regenerateSummary keeps the existing summary when the summarizer fails', async () => {
  const { db, id } = seedDone({ provider: 'openai' });
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await regenerateSummary(db, id);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
  assert.equal(db.getSummary(id).notes.tldr, 'Old summary.');
  assert.equal(db.getMeeting(id).status, 'done');
  assert.equal(db.listTodos('g1').length, 2);
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('POST /api/meetings/:id/regenerate regenerates and the bundle advertises eligibility', async () => {
  const { db, id } = seedDone();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const { base, close } = await listen(app);
  try {
    const bundle = await (await fetch(`${base}/api/meetings/${id}`)).json();
    assert.equal(bundle.regenerate.eligible, true);

    const r = await fetch(`${base}/api/meetings/${id}/regenerate`, { method: 'POST' });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.state, 'running');
    let status;
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await (await fetch(`${base}/api/meetings/${id}/regenerate`)).json();
      if (status.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.state, 'done');
    assert.equal(db.getSummary(id).notes.tldr, 'Fake summary.');

    assert.equal((await fetch(`${base}/api/meetings/9999/regenerate`, { method: 'POST' })).status, 404);

    db.setMeetingStatus(id, 'processing');
    const busy = await fetch(`${base}/api/meetings/${id}/regenerate`, { method: 'POST' });
    assert.equal(busy.status, 409);
  } finally { close(); }
});

test('POST /api/meetings/:id/regenerate is admin-only', async () => {
  const { db, id } = seedDone();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authResolved = true; req.user = { id: 2, username: 'bob', isAdmin: false }; next(); });
  app.use('/api', apiRouter({ db, client: null }));
  const { base, close } = await listen(app);
  try {
    const r = await fetch(`${base}/api/meetings/${id}/regenerate`, { method: 'POST' });
    assert.equal(r.status, 403);
    assert.equal(db.getSummary(id).notes.tldr, 'Old summary.');
  } finally { close(); }
});
