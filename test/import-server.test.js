// Imports through the real web server stack: session auth, the same-origin
// guard and the global JSON parser must let a raw upload through, and the
// server must allow uploads that take longer than Node's 5-minute default.
import { config } from '../src/config/env.js';
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { startWebServer } from '../src/web/server.js';
import { IMPORT_REQUEST_TIMEOUT_MS } from '../src/web/import-routes.js';

async function loginCookie(base) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const changed = await fetch(`${base}/api/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ newPassword: 'admin-secret-1' }),
  });
  const rotated = changed.headers.get('set-cookie');
  if (rotated) cookie = rotated.split(';')[0];
  return cookie;
}

test('the web server allows long uploads (request timeout well above 5 minutes)', async () => {
  const server = await startWebServer({ db: openDb(':memory:'), port: 0 });
  try {
    assert.ok(IMPORT_REQUEST_TIMEOUT_MS >= 60 * 60 * 1000);
    assert.equal(server.requestTimeout, IMPORT_REQUEST_TIMEOUT_MS);
  } finally { server.close(); }
});

test('a raw upload passes auth, CSRF and the JSON parser, and a failing import is recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-server-'));
  const sidecar = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', diarization: { available: false, reason: 'off' } }));
  });
  await new Promise((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const saved = { dataDir: config.dataDir, sttUrl: config.sttUrl };
  Object.assign(config, { dataDir: dir, sttUrl: `http://127.0.0.1:${sidecar.address().port}` });
  const db = openDb(':memory:');
  setGuildConfig(db, 'g1', {});
  const server = await startWebServer({ db, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = await loginCookie(base);
    const capability = await (await fetch(`${base}/api/imports/capability`, { headers: { cookie } })).json();
    assert.deepEqual(capability, { available: true, speakerDetection: false, reason: 'off', maxBytes: config.importMaxBytes });

    const headers = { cookie, origin: base, 'content-type': 'video/mp4' };
    const crossSite = await fetch(`${base}/api/guilds/g1/imports`, { method: 'POST', body: 'x',
      headers: { ...headers, origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);

    const res = await fetch(`${base}/api/guilds/g1/imports?title=Clip&filename=clip.mp4`,
      { method: 'POST', body: Buffer.from('not really a video'), headers });
    assert.equal(res.status, 202);
    const { meetingId } = await res.json();
    for (let i = 0; i < 200 && db.getMeeting(meetingId).status === 'processing'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const meeting = db.getMeeting(meetingId);
    // ffmpeg is either missing or can't read the fake bytes; both fail cleanly.
    assert.equal(meeting.status, 'transcription_failed');
    assert.match(meeting.import_error, /ffmpeg is not installed|could not be read as audio or video/);
    assert.deepEqual(readdirSync(join(dir, 'imports')), []);
    assert.equal(existsSync(join(dir, 'audio', String(meetingId))), false);
  } finally {
    Object.assign(config, saved);
    server.closeAllConnections();
    server.close();
    sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
