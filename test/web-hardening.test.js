// test/web-hardening.test.js — server-level error handling and cookie parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { createWebServer, jsonErrorHandler } from '../src/web/server.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('unexpected errors become a generic JSON 500 without a stack trace', async (t) => {
  const logged = [];
  const app = express();
  app.get('/boom', () => { throw new Error('secret internals at /srv/app.js:12'); });
  app.use(jsonErrorHandler({ error: (...args) => logged.push(args) }));
  const base = await listen(t, app);
  const res = await fetch(`${base}/boom`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Something went wrong on the server.' });
  assert.equal(text.includes('secret internals'), false);
  assert.equal(logged.length, 1);
});

test('malformed JSON bodies get a JSON 400 from the real server', async (t) => {
  const base = await listen(t, createWebServer({ db: openDb(':memory:') }));
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
  assert.equal(JSON.stringify(body).includes('at '), false);
});

test('a malformed session cookie never breaks a route', async (t) => {
  const base = await listen(t, createWebServer({ db: openDb(':memory:') }));
  const cookie = 'parley_session=%E0%A4%A';
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/guilds`, { headers: { cookie } })).status, 401);
});

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

// A built dashboard: the app shell plus one hashed asset.
function fakeDist(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parley-dist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.info(1)');
  return dir;
}

test('every response carries the security headers, and Express is not advertised', async (t) => {
  const base = await listen(t, createWebServer({ db: openDb(':memory:'), distDir: fakeDist(t) }));
  for (const path of ['/api/auth/me', '/api/guilds', '/', '/assets/index-abc123.js', '/assets/gone.js']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get('content-security-policy'), EXPECTED_CSP, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-powered-by'), null, path);
  }
});

test('a missing /assets file is a 404 (a stale tab must not get the app shell as a script)', async (t) => {
  const base = await listen(t, createWebServer({ db: openDb(':memory:'), distDir: fakeDist(t) }));
  assert.equal((await fetch(`${base}/assets/index-abc123.js`)).status, 200);
  const missing = await fetch(`${base}/assets/index-old999.js`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.text()).includes('id="root"'), false);
  const route = await fetch(`${base}/meetings/7`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /id="root"/);
});
