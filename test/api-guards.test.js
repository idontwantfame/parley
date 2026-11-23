// test/api-guards.test.js — state guards for destructive meeting routes,
// merge/delete artifact cleanup, config field gating and input validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { apiRouter } from '../src/web/api.js';
import { config as env } from '../src/config/env.js';
import { withMeetingProgress } from '../src/pipeline/progress.js';
import { clearModelCache } from '../src/adapters/summarizer/models.js';

// Point the data/export folders at a temp dir for the duration of a test.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parley-guards-'));
  const previous = { dataDir: env.dataDir, exportDir: env.exportDir, autoExport: env.autoExport };
  Object.assign(env, { dataDir: dir, exportDir: join(dir, 'exports'), autoExport: true });
  t.after(() => { Object.assign(env, previous); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

async function serve(t, db, { bot = null, user, mixAudio } = {}) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req, _res, next) => { req.authResolved = true; req.user = user; next(); });
  app.use('/api', apiRouter({ db, bot, client: null, ...(mixAudio ? { mixAudio } : {}) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return (method, path, body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function meeting(db, { status = 'done', guildId = 'g1', text = 'hello' } = {}) {
  const id = Number(db.createMeeting({ guildId, channelId: 'c', channelName: 'Voice', startedAt: '2026-03-04T05:06:07Z' }));
  db.setMeetingStatus(id, status);
  db.addAttendee(id, 'u1', 'Alice');
  db.addUtterance({ meetingId: id, userId: 'u1', displayName: 'Alice', startMs: id, endMs: id + 1, text });
  return id;
}

function addAudio(dir, id) {
  mkdirSync(join(dir, 'audio', String(id)), { recursive: true });
  writeFileSync(join(dir, 'audio', String(id), `u1_${1000 + id}.pcm`), Buffer.alloc(64));
}

test('recording or live meetings cannot be deleted, merged, retried, regenerated or stripped of audio', async (t) => {
  const dir = sandbox(t);
  const db = openDb(':memory:');
  const recording = meeting(db, { status: 'recording' });
  const live = meeting(db);
  db.setAudioRetained(live, true);
  const target = meeting(db);
  for (const id of [recording, live]) addAudio(dir, id);
  const bot = { liveMeetings: () => [{ meetingId: live, guildId: 'g1', channelId: 'c', phase: 'processing' }] };
  const call = await serve(t, db, { bot });

  for (const id of [recording, live]) {
    assert.equal((await call('DELETE', `/meetings/${id}`)).status, 409, `delete ${id}`);
    assert.equal((await call('POST', `/meetings/${target}/merge`, { sourceIds: [id] })).status, 409, `merge source ${id}`);
    assert.equal((await call('POST', `/meetings/${id}/merge`, { sourceIds: [target] })).status, 409, `merge target ${id}`);
    assert.equal((await call('POST', `/meetings/${id}/retry`)).status, 409, `retry ${id}`);
    assert.ok(db.getMeeting(id));
    assert.ok(existsSync(join(dir, 'audio', String(id))));
  }
  assert.equal((await call('POST', `/meetings/${live}/regenerate`)).status, 409);
  assert.equal((await call('DELETE', `/meetings/${live}/audio`)).status, 409);
  assert.ok(existsSync(join(dir, 'audio', String(live))));
  assert.equal(db.listUtterances(target).length, 1);
});

test('merge refuses sources that are being processed or delivered', async (t) => {
  sandbox(t);
  const db = openDb(':memory:');
  const target = meeting(db);
  const sending = meeting(db);
  db.beginDelivery(sending, 'now');
  const busy = meeting(db);
  let release;
  const running = withMeetingProgress(busy, null, () => new Promise((resolve) => { release = resolve; }));
  const call = await serve(t, db);
  try {
    assert.equal((await call('POST', `/meetings/${target}/merge`, { sourceIds: [sending] })).status, 409);
    assert.equal((await call('POST', `/meetings/${target}/merge`, { sourceIds: [busy] })).status, 409);
    assert.equal((await call('POST', `/meetings/${busy}/merge`, { sourceIds: [target] })).status, 409);
    assert.equal(db.listUtterances(target).length, 1);
  } finally { release(); await running; }
});

test('merge keeps ticked action items, refreshes the target export and removes the sources files', async (t) => {
  const dir = sandbox(t);
  const db = openDb(':memory:');
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', 'fake')`).run();
  const target = meeting(db, { text: 'first part' });
  const source = meeting(db, { text: 'second part' });
  db.saveSummary(target, { tldr: 'old', actionItems: [{ assignee: 'Alice', task: 'do thing' }] }, [], 'm');
  db.seedTodos(target, 'g1', [{ assignee: 'Alice', task: 'do thing' }]);
  db.setTodoDone(db.listTodos('g1')[0].id, true);
  const exportsDir = join(dir, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, `meeting-${source}-2026-03-04.md`), 'source transcript');
  writeFileSync(join(exportsDir, `meeting-${source}-2026-03-04.json`), '{}');
  addAudio(dir, source);
  const call = await serve(t, db);

  const res = await call('POST', `/meetings/${target}/merge`, { sourceIds: [source] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).merged, [source]);
  assert.equal(db.getSummary(target).notes.tldr, 'Fake summary.');
  assert.deepEqual(db.listTodos('g1').map((todo) => [todo.task, todo.done]), [['do thing', 1]]);
  assert.deepEqual(readdirSync(exportsDir).sort(), [`meeting-${target}-2026-03-04.json`, `meeting-${target}-2026-03-04.md`]);
  assert.equal(existsSync(join(dir, 'audio', String(source))), false);
});

test('deleting a meeting removes its exported transcript files too', async (t) => {
  const dir = sandbox(t);
  const db = openDb(':memory:');
  const id = meeting(db);
  const exportsDir = join(dir, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  for (const ext of ['md', 'json']) writeFileSync(join(exportsDir, `meeting-${id}-2026-03-04.${ext}`), 'x');
  addAudio(dir, id);
  const call = await serve(t, db);
  assert.equal((await call('DELETE', `/meetings/${id}`)).status, 200);
  assert.deepEqual(readdirSync(exportsDir), []);
  assert.equal(existsSync(join(dir, 'audio', String(id))), false);
});

test('non-admins can change benign settings but not transcription, auto-join or prompts', async (t) => {
  const db = openDb(':memory:');
  meeting(db);
  const call = await serve(t, db, { user: { id: 2, username: 'bob', isAdmin: false } });
  for (const patch of [{ sttProvider: 'sidecar' }, { sttModel: 'whisper-1' }, { whisperModel: 'large-v3' }, { autoJoin: false }, { autoJoinMinPeople: 3 },
    { autoJoinChannelIds: null }, { summaryPrompt: 'x' }, { overviewPrompt: 'y' }, { keepAudio: true }]) {
    assert.equal((await call('PATCH', '/guilds/g1/config', patch)).status, 403, JSON.stringify(patch));
  }
  const ok = await call('PATCH', '/guilds/g1/config', { language: 'en', useThread: false });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).config.language, 'en');
});

test('config PATCH rejects unknown servers and non-string ids', async (t) => {
  const db = openDb(':memory:');
  meeting(db);
  const call = await serve(t, db);
  assert.equal((await call('PATCH', '/guilds/nope/config', { whisperModel: 'base' })).status, 404);
  assert.equal(db.sql.prepare(`SELECT COUNT(*) AS c FROM guild_config`).get().c, 0);
  for (const patch of [{ model: { a: 1 } }, { notesChannelId: ['x'] }, { fallbackModel: 5 }, { sttModel: {} }]) {
    assert.equal((await call('PATCH', '/guilds/g1/config', patch)).status, 400, JSON.stringify(patch));
  }
  assert.equal((await call('PATCH', '/guilds/g1/config')).status, 200); // no body
});

test('bad query and body types are 400s, not 500s', async (t) => {
  const db = openDb(':memory:');
  const id = meeting(db);
  db.seedTodos(id, 'g1', [{ task: 'x' }]);
  const call = await serve(t, db);
  assert.equal((await call('GET', '/guilds/g1/search?q=a&q=b')).status, 400);
  const nul = await call('GET', '/guilds/g1/search?q=a%00b');
  assert.equal(nul.status, 200);
  assert.deepEqual(await nul.json(), []);
  const todo = db.listTodos('g1')[0].id;
  assert.equal((await call('PATCH', `/todos/${todo}`)).status, 400);
  assert.equal((await call('PATCH', `/todos/${todo}`, { done: 'yes' })).status, 400);
  assert.equal((await call('PATCH', `/todos/${todo}`, { done: true })).status, 200);
  assert.equal((await call('GET', '/guilds/g1/todos?assignee=a&assignee=b')).status, 400);
});

test('unlinking a channel is scoped to the campaign in the URL', async (t) => {
  const db = openDb(':memory:');
  const a = db.createCampaign({ guildId: 'g1', name: 'A' });
  const b = db.createCampaign({ guildId: 'g1', name: 'B' });
  db.linkCampaignChannel(a, { guildId: 'g1', channelId: 'voice' });
  const call = await serve(t, db);
  assert.equal((await call('DELETE', `/campaigns/${b}/channels/voice`)).status, 404);
  assert.equal(db.listCampaignChannels(a).length, 1);
  assert.equal((await call('DELETE', `/campaigns/${a}/channels/voice`)).status, 200);
  assert.equal(db.listCampaignChannels(a).length, 0);
});

test('concurrent recording downloads share one mix', async (t) => {
  const dir = sandbox(t);
  const db = openDb(':memory:');
  const id = meeting(db);
  db.setAudioRetained(id, true);
  addAudio(dir, id);
  const wav = join(dir, 'mixed.wav');
  writeFileSync(wav, Buffer.alloc(64));
  let mixes = 0;
  const mixAudio = async () => { mixes += 1; await new Promise((r) => setTimeout(r, 30)); return wav; };
  const call = await serve(t, db, { mixAudio });
  const responses = await Promise.all([1, 2, 3].map(() => call('GET', `/meetings/${id}/audio`)));
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 200]);
  assert.equal(mixes, 1);
});

test('only admins can bypass the model catalog cache', async (t) => {
  const previousKey = env.gemini.apiKey;
  env.gemini.apiKey = undefined;
  clearModelCache('gemini');
  t.after(() => { env.gemini.apiKey = previousKey; clearModelCache('gemini'); });
  const db = openDb(':memory:');
  const viewer = await serve(t, db, { user: { id: 2, username: 'bob', isAdmin: false } });
  const admin = await serve(t, db, { user: { id: 1, username: 'root', isAdmin: true } });
  const first = await (await viewer('GET', '/providers/gemini/models')).json();
  await new Promise((r) => setTimeout(r, 5));
  const viewerRefresh = await (await viewer('GET', '/providers/gemini/models?refresh=1')).json();
  assert.equal(viewerRefresh.fetchedAt, first.fetchedAt);
  const adminRefresh = await (await admin('GET', '/providers/gemini/models?refresh=1')).json();
  assert.notEqual(adminRefresh.fetchedAt, first.fetchedAt);
});
