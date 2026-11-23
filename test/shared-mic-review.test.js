import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { getGuildConfig, setGuildConfig } from '../src/store/config.js';
import { reconcileOnBoot } from '../src/store/reconcile.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';
import { transcribeTracks } from '../src/pipeline/transcribe.js';
import { canDiscardAudio } from '../src/voice/recording-archive.js';
import { pcmName } from '../src/voice/audio.js';
import { apiRouter } from '../src/web/api.js';

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('shared mic turns are diarized together, then approved names reach Ollama', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-shared-review-'));
  const original = { dataDir: config.dataDir, ollama: config.ollama, autoExport: config.autoExport };
  let db;
  t.after(async () => {
    Object.assign(config, original);
    db?.sql.close();
    await rm(dir, { recursive: true, force: true });
  });
  const prompts = [];
  const ollama = createServer(async (req, res) => {
    const body = [];
    for await (const data of req) body.push(data);
    prompts.push(JSON.parse(Buffer.concat(body)).messages[0].content);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({
      tldr: 'Notes', topics: [], decisions: [], openQuestions: [], actionItems: [],
    }) } }));
  });
  t.after(() => ollama.close());
  config.ollama = { url: await start(ollama) };
  config.dataDir = dir;
  config.autoExport = false;

  const dbPath = join(dir, 'meetings.db');
  db = openDb(dbPath);
  const micId = '100000000000000001';
  const soloId = '100000000000000002';
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c1', channelName: 'Game', startedAt: new Date(10000).toISOString() });
  db.addAttendee(id, micId, 'pitnokit');
  db.addAttendee(id, soloId, 'Valentin');
  setGuildConfig(db, 'g1', { sharedMicUserIds: [micId], language: 'pl', summarizerProvider: 'ollama', summarizerModel: 'test' });
  const audioRoot = join(dir, 'audio');
  const audioDir = join(audioRoot, String(id));
  await mkdir(audioDir, { recursive: true });
  const tracks = [];
  for (const [userId, displayName, startMs] of [[micId, 'pitnokit', 10000], [soloId, 'Valentin', 11000], [micId, 'pitnokit', 12000]]) {
    const pcmPath = join(audioDir, pcmName(userId, startMs));
    await writeFile(pcmPath, Buffer.alloc(3200, 1));
    tracks.push({ userId, displayName, startMs, pcmPath });
  }
  let sharedRequests = 0;
  const result = await processMeeting(db, id, {
    tracks, cfg: getGuildConfig(db, 'g1'),
    transcribe: (audio, cfg) => transcribeTracks(audio, cfg, {
      meetingId: id,
      stt: async () => ({ text: 'Dobrze' }),
      sttDeps: { fetchImpl: async (_url, request) => {
        sharedRequests++;
        assert.equal(request.body.get('language'), 'pl');
        assert.equal(request.body.get('diarize'), 'true');
        assert.equal(request.body.get('file').size, 44 + 32_000 * 2 + 3200);
        return Response.json({ segments: [
          { speaker: 'SPEAKER_12', start: 0, end: 0.09, text: 'Otwieram drzwi' },
          { speaker: 'SPEAKER_43', start: 2, end: 2.05, text: 'Wchodzę' },
          { speaker: 'SPEAKER_12', start: 2.05, end: 2.09, text: 'Czekaj' },
        ] });
      } },
    }),
  });
  assert.equal(sharedRequests, 1);
  assert.equal(result.reviewPending, true);
  assert.equal(canDiscardAudio(result, db.getMeeting(id)), false);
  assert.equal(db.getMeeting(id).status, 'speaker_review');
  assert.equal(prompts.length, 0);
  const speakers = db.listUtterances(id);
  assert.equal(speakers[0].display_name, 'pitnokit · Speaker 1');
  assert.equal(speakers[1].display_name, 'Valentin');
  assert.equal(speakers[3].user_id, speakers[0].user_id);
  assert.equal(speakers[2].start_ms, 12000);

  // Restart during the review and continue with the same labels and audio.
  db.sql.close();
  db = openDb(dbPath);
  await reconcileOnBoot(db, audioRoot);
  assert.equal(db.getMeeting(id).status, 'speaker_review');
  assert.equal(existsSync(tracks[0].pcmPath), true);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-viewer')) {
      req.authResolved = true;
      req.user = { id: 2, isAdmin: false };
    }
    next();
  });
  app.use('/api', apiRouter({ db }));
  const server = createServer(app);
  t.after(() => server.close());
  const meetingUrl = `${await start(server)}/api/meetings/${id}`;
  const bundle = await (await fetch(meetingUrl)).json();
  assert.equal(bundle.hasAudio, true);
  assert.equal(bundle.audioOriginMs, 10000);
  const viewer = await fetch(`${meetingUrl}/audio`, { headers: { 'x-viewer': '1' } });
  assert.equal(viewer.status, 404);
  const sample = await fetch(`${meetingUrl}/audio?inline=1`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(sample.status, 206);
  assert.match(Buffer.from(await sample.arrayBuffer()).toString('ascii', 0, 4), /^RIFF$/);
  const approve = (names, headers) => fetch(`${meetingUrl}/speaker-review`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ names }),
  });
  assert.equal((await approve({}, { 'x-viewer': '1' })).status, 403);
  assert.equal((await approve({ [soloId]: 'Wrong' })).status, 400);
  assert.equal((await approve({ [speakers[0].user_id]: 'Paweł', [speakers[2].user_id]: 'Kamil' })).status, 202);
  assert.equal((await approve({})).status, 409);
  const deadline = Date.now() + 5000;
  while ((db.getMeeting(id).status !== 'done' || existsSync(audioDir)) && Date.now() < deadline) await delay(10);
  assert.equal(db.getMeeting(id).status, 'done');
  assert.equal(db.getSummary(id).notes.tldr, 'Notes');
  assert.equal(existsSync(audioDir), false, 'review audio is removed when Keep recordings is off');
  assert.deepEqual(db.listUtterances(id).map((line) => line.display_name), ['Paweł', 'Valentin', 'Kamil', 'Paweł']);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Paweł: Otwieram drzwi.+Valentin: Dobrze.+Kamil: Wchodzę.+Paweł: Czekaj/s);
});
