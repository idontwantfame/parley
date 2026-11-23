// Imports through the real web server stack: session auth, the same-origin
// guard and the global JSON parser must let a raw upload through, and only an
// admin's upload may take longer than the default 5-minute request deadline.
import { config } from '../src/config/env.js';
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { startWebServer } from '../src/web/server.js';
import { installUsers } from '../src/store/users.js';

// The seeded admin's first-run password is random; pin it to 'admin' here.
const ADMIN_SEED = { firstRunPassword: 'admin', log: { warn() {}, info() {}, log() {} } };

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

// Send part of a request, then stall; resolve with the reply once the server
// closes the connection (or after waitMs).
function stalledRequest(port, path, waitMs = 2000) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let reply = '';
    const done = () => { clearTimeout(timer); socket.destroy(); resolve(reply); };
    const timer = setTimeout(done, waitMs);
    socket.on('data', (chunk) => { reply += chunk.toString(); });
    socket.on('close', done);
    socket.on('error', done);
    socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"user`);
  });
}

async function waitForImportFailure(db, meetingId) {
  const deadline = Date.now() + 5000;
  do {
    const meeting = db.getMeeting(meetingId);
    if (meeting?.import_error) return meeting;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Import ${meetingId} did not report its failure`);
}

test('a request that is not received by the default deadline is refused, before any sign-in', async () => {
  const server = await startWebServer({ db: openDb(':memory:'), port: 0, timeouts: { requestMs: 150 } });
  try {
    assert.notEqual(server.requestTimeout, 2 * 60 * 60 * 1000, 'no server-wide 2-hour deadline');
    const reply = await stalledRequest(server.address().port, '/api/auth/login');
    assert.match(reply, /^HTTP\/1\.1 408/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('an admin recording upload may take longer than the default request deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-slow-'));
  const sidecar = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', diarization: { available: false, reason: 'off' } }));
  });
  await new Promise((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const saved = { dataDir: config.dataDir, sttUrl: config.sttUrl };
  Object.assign(config, { dataDir: dir, sttUrl: `http://127.0.0.1:${sidecar.address().port}` });
  const db = openDb(':memory:');
  setGuildConfig(db, 'g1', {});
  installUsers(db, ADMIN_SEED);
  const server = await startWebServer({ db, port: 0, timeouts: { requestMs: 150 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = await loginCookie(base);
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent === 2) return controller.close();
        if (sent === 1) await new Promise((resolve) => setTimeout(resolve, 400)); // past the default deadline
        sent += 1;
        controller.enqueue(new Uint8Array(1000));
      },
    });
    const res = await fetch(`${base}/api/guilds/g1/imports?filename=slow.mp3`, { method: 'POST', body, duplex: 'half',
      headers: { cookie, origin: base, 'content-type': 'audio/mpeg' } });
    assert.equal(res.status, 202);
    const { meetingId } = await res.json();
    // Let the background import settle before the next test starts a fresh DB
    // whose first meeting uses the same id.
    await waitForImportFailure(db, meetingId);
  } finally {
    Object.assign(config, saved);
    server.closeAllConnections();
    server.close();
    sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
  installUsers(db, ADMIN_SEED);
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
    const meeting = await waitForImportFailure(db, meetingId);
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
