// HTTP API for importing a recording made outside Discord.
import { config } from '../src/config/env.js';
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { apiRouter } from '../src/web/api.js';
import { sameOrigin } from '../src/web/auth.js';
import { jsonErrorHandler } from '../src/web/server.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { runImport } from '../src/pipeline/import.js';

const READY = { available: true, speakerDetection: true, reason: null };

function setup({ isAdmin = true, capability = READY, maxBytes = 1_000_000, client = null, startImport } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-api-'));
  const db = openDb(':memory:');
  setGuildConfig(db, 'g1', { language: 'pl' });
  const jobs = [];
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { req.authResolved = true; req.user = { isAdmin }; next(); });
  app.use('/api', sameOrigin);
  app.use('/api', apiRouter({ db, client, imports: {
    capability: async () => capability, dataDir: dir, maxBytes, log: { error: () => {} },
    startImport: startImport ?? (async (_db, meetingId, job) => { jobs.push({ meetingId, ...job }); }),
  } }));
  app.use(jsonErrorHandler({ error: () => {} }));
  return { dir, db, app, jobs };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function withServer(options, run) {
  const ctx = setup(options);
  const { base, close } = await listen(ctx.app);
  try { await run({ ...ctx, base }); } finally {
    close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
}

const upload = (base, query = '', body = Buffer.from('fake audio bytes'), headers = {}) => fetch(
  `${base}/api/guilds/g1/imports${query}`,
  { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });

const uploads = (dir) => (existsSync(join(dir, 'imports')) ? readdirSync(join(dir, 'imports')) : []);
const meetingCount = (db) => db.sql.prepare('SELECT COUNT(*) AS n FROM meetings').get().n;

test('capability reports what the sidecar can do and the upload limit, to any user', async () => {
  const capability = { available: true, speakerDetection: false, reason: 'no token' };
  await withServer({ isAdmin: false, capability, maxBytes: 1234 }, async ({ base }) => {
    const res = await fetch(`${base}/api/imports/capability`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: true, speakerDetection: false, reason: 'no token', maxBytes: 1234 });
  });
});

test('an upload is streamed to disk, filed as an import meeting and started in the background', async () => {
  await withServer({}, async ({ base, db, dir, jobs }) => {
    const query = '?title=Board%20call&startedAt=2026-11-20T10:00:00Z&language=en&speakers=1&minSpeakers=2&maxSpeakers=4&filename=call.M4A';
    const res = await upload(base, query, Buffer.from('fake audio bytes'),
      { 'content-type': 'audio/mp4', origin: base });
    assert.equal(res.status, 202);
    const { ok, meetingId } = await res.json();
    assert.equal(ok, true);
    const meeting = db.getMeeting(meetingId);
    assert.deepEqual([meeting.channel_name, meeting.started_at, meeting.source, meeting.status],
      ['Board call', '2026-11-20T10:00:00.000Z', 'import', 'processing']);
    assert.equal(jobs.length, 1);
    const { uploadPath, ...job } = jobs[0];
    assert.deepEqual(job, { meetingId, language: 'en', speakers: true, minSpeakers: 2, maxSpeakers: 4, deliver: null });
    assert.equal(uploadPath.startsWith(join(dir, 'imports')), true);
    assert.match(uploadPath, /\.m4a$/);
    assert.equal(readFileSync(uploadPath, 'utf8'), 'fake audio bytes');
  });
});

test('import options default sensibly, and speaker bounds are ignored without speaker detection', async () => {
  await withServer({ capability: { available: true, speakerDetection: false, reason: 'off' } }, async ({ base, db, jobs }) => {
    const before = Date.now();
    const res = await upload(base, '?minSpeakers=abc&filename=noext');
    assert.equal(res.status, 202);
    const meeting = db.getMeeting((await res.json()).meetingId);
    assert.equal(meeting.channel_name, 'Imported recording');
    assert.ok(Date.parse(meeting.started_at) >= before - 1000 && Date.parse(meeting.started_at) <= Date.now());
    assert.deepEqual([jobs[0].language, jobs[0].speakers, jobs[0].minSpeakers, jobs[0].maxSpeakers], ['pl', false, null, null]);
    assert.match(jobs[0].uploadPath, /\.bin$/);
  });
});

test('imports are admin-only and limited to known servers', async () => {
  await withServer({ isAdmin: false }, async ({ base }) => {
    assert.equal((await upload(base)).status, 403);
  });
  await withServer({}, async ({ base, dir }) => {
    const res = await fetch(`${base}/api/guilds/nope/imports`, { method: 'POST', body: 'x', headers: { 'content-type': 'audio/mpeg' } });
    assert.equal(res.status, 404);
    assert.deepEqual(uploads(dir), []);
  });
});

test('bad import options are refused before anything is stored', async () => {
  await withServer({}, async ({ base, db, dir }) => {
    for (const query of [`?title=${'x'.repeat(101)}`, '?title=a%0Ab', '?startedAt=yesterday', '?startedAt=2026-13-45',
      '?language=xx', '?speakers=1&minSpeakers=0', '?speakers=1&maxSpeakers=21', '?speakers=1&minSpeakers=4&maxSpeakers=2',
      '?title=a&title=b', '?speakers=yes', '?post=maybe']) {
      const res = await upload(base, query);
      assert.equal(res.status, 400, query);
      assert.ok((await res.json()).error, query);
    }
    assert.equal(meetingCount(db), 0);
    assert.deepEqual(uploads(dir), []);
  });
});

test('an empty body or a non-media content type is refused', async () => {
  await withServer({}, async ({ base, db, dir }) => {
    assert.equal((await upload(base, '', Buffer.alloc(0))).status, 400);
    const json = await upload(base, '', JSON.stringify({ a: 1 }), { 'content-type': 'application/json' });
    assert.equal(json.status, 415);
    const form = await upload(base, '', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    assert.equal(meetingCount(db), 0);
    assert.deepEqual(uploads(dir), []);
  });
});

test('an unreachable sidecar, or missing speaker detection when asked for, is a 409 with the reason', async () => {
  const down = { available: false, speakerDetection: false, reason: 'The local speech-to-text sidecar is not reachable.' };
  await withServer({ capability: down }, async ({ base, db }) => {
    const res = await upload(base);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: down.reason });
    assert.equal(meetingCount(db), 0);
  });
  const noSpeakers = { available: true, speakerDetection: false, reason: 'Speaker detection needs the -full image.' };
  await withServer({ capability: noSpeakers }, async ({ base, db }) => {
    const res = await upload(base, '?speakers=1');
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: noSpeakers.reason });
    assert.equal((await upload(base, '?speakers=0')).status, 202);
    assert.equal(meetingCount(db), 1);
  });
});

test('uploads over the size cap get 413 and leave no partial file', async () => {
  await withServer({ maxBytes: 1000 }, async ({ base, db, dir }) => {
    assert.equal((await upload(base, '', Buffer.alloc(1001))).status, 413);
    // Without a Content-Length the cap is enforced while streaming.
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (sent > 50_000) return controller.close();
        sent += 500;
        controller.enqueue(new Uint8Array(500));
      },
    });
    const res = await fetch(`${base}/api/guilds/g1/imports`, { method: 'POST', body, duplex: 'half',
      headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /larger than/);
    assert.equal(meetingCount(db), 0);
    assert.deepEqual(uploads(dir), []);
  });
});

test('posting to Discord needs a notes channel and uses the live bot', async () => {
  const client = { guilds: { cache: new Map() }, channels: { cache: new Map() } };
  await withServer({ client }, async ({ base, db, jobs }) => {
    const missing = await upload(base, '?post=1');
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /notes channel/);
    setGuildConfig(db, 'g1', { notesChannelId: '42' });
    assert.equal((await upload(base, '?post=1')).status, 202);
    assert.equal(typeof jobs[0].deliver, 'function');
    assert.equal((await upload(base, '?post=0')).status, 202);
    assert.equal(jobs[1].deliver, null);
  });
  await withServer({}, async ({ base, db, jobs }) => {
    setGuildConfig(db, 'g1', { notesChannelId: '42' });
    assert.equal((await upload(base, '?post=1')).status, 202);
    assert.equal(jobs[0].deliver, null, 'no bot connected: like a retry, nothing is posted');
  });
});

test('a background import failure is logged, never an unhandled rejection', async () => {
  await withServer({ startImport: async () => { throw new Error('boom'); } }, async ({ base }) => {
    assert.equal((await upload(base)).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

test('end to end: progress shows the import stage right away, then the meeting is done', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = (dir) => ({
    dataDir: dir, summarizer: new FakeSummarizer(),
    runFfmpeg: async (_cmd, args) => { await writeFile(args[args.length - 1], 'mp3'); },
    transcribe: async () => { await gate; return { text: 'Hello.', segments: [{ start: 0, end: 1, text: 'Hello.' }] }; },
  });
  const ctx = { dir: null };
  const savedDataDir = config.dataDir;
  await withServer({ startImport: (db, id, job) => runImport(db, id, job, deps(ctx.dir)) }, async ({ base, db, dir }) => {
    ctx.dir = dir;
    config.dataDir = dir; // the meeting detail looks for the recording under DATA_DIR
    const res = await upload(base, '?title=Standup');
    assert.equal(res.status, 202);
    const { meetingId } = await res.json();
    const progress = await (await fetch(`${base}/api/meetings/${meetingId}/progress`)).json();
    assert.equal(progress.status, 'processing');
    assert.equal(progress.progress.stage, 'importing');
    release();
    for (let i = 0; i < 100 && db.getMeeting(meetingId).status === 'processing'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const detail = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
    assert.equal(detail.meeting.status, 'done');
    assert.equal(detail.meeting.source, 'import');
    assert.equal(detail.hasAudio, true);
    assert.equal(detail.audioOriginMs, Date.parse(detail.meeting.started_at));
    assert.equal(detail.utterances[0].display_name, 'Speaker 1');
    assert.deepEqual(uploads(dir), []);
  }).finally(() => { config.dataDir = savedDataDir; });
});

test('a client that gives up mid-upload leaves no file and no meeting behind', async () => {
  const errors = [];
  const ctx = setup();
  const app = express();
  app.use((req, _res, next) => { req.authResolved = true; req.user = { isAdmin: true }; next(); });
  app.use('/api', apiRouter({ db: ctx.db, imports: { capability: async () => READY, dataDir: ctx.dir, maxBytes: 1e9,
    log: { error: (m) => errors.push(m) }, startImport: async () => assert.fail('nothing to import') } }));
  app.use(jsonErrorHandler({ error: (...args) => errors.push(args.join(' ')) }));
  const { base, close } = await listen(app);
  try {
    const controller = new AbortController();
    let chunks = 0;
    const body = new ReadableStream({
      async pull(c) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (controller.signal.aborted) return c.close();
        if (++chunks === 20) controller.abort();
        c.enqueue(new Uint8Array(1000));
      },
    });
    await assert.rejects(fetch(`${base}/api/guilds/g1/imports`, { method: 'POST', body, duplex: 'half',
      signal: controller.signal, headers: { 'content-type': 'audio/mpeg' } }));
    for (let i = 0; i < 50 && (uploads(ctx.dir).length || !errors.length); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(uploads(ctx.dir), []);
    assert.equal(meetingCount(ctx.db), 0);
  } finally {
    close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a client that gives up while the upload is still being checked leaves no file behind', async () => {
  const { connect } = await import('node:net');
  let probes = 0;
  const slowCapability = async () => { probes++; await new Promise((resolve) => setTimeout(resolve, 200)); return READY; };
  const ctx = setup({ capability: READY, maxBytes: 1e9 });
  const app = express();
  app.use((req, _res, next) => { req.authResolved = true; req.user = { isAdmin: true }; next(); });
  app.use('/api', apiRouter({ db: ctx.db, imports: { capability: slowCapability, dataDir: ctx.dir, maxBytes: 1e9,
    log: { error: () => {} }, startImport: async () => assert.fail('nothing to import') } }));
  app.use(jsonErrorHandler({ error: () => {} }));
  const { base, close } = await listen(app);
  try {
    const socket = connect(Number(new URL(base).port), '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('POST /api/guilds/g1/imports HTTP/1.1\r\nHost: x\r\nContent-Type: audio/mpeg\r\nContent-Length: 100000\r\n\r\n');
    socket.write(Buffer.alloc(1000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy(); // gone while the sidecar capability check is still running
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(probes, 1);
    assert.deepEqual(uploads(ctx.dir), []);
    assert.equal(meetingCount(ctx.db), 0);
  } finally {
    close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('every refused upload closes the connection', async () => {
  await withServer({ maxBytes: 1000 }, async ({ base }) => {
    const refusals = [
      await upload(base, '?speakers=maybe'),
      await upload(base, '', Buffer.alloc(0)),
      await upload(base, '', Buffer.alloc(1001)),
    ];
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (sent > 5000) return controller.close();
        sent += 500;
        controller.enqueue(new Uint8Array(500));
      },
    });
    refusals.push(await fetch(`${base}/api/guilds/g1/imports`, { method: 'POST', body, duplex: 'half',
      headers: { 'content-type': 'application/octet-stream' } }));
    for (const res of refusals) {
      assert.ok(res.status >= 400, `status ${res.status}`);
      assert.equal(res.headers.get('connection'), 'close', `status ${res.status}`);
    }
  });
});
