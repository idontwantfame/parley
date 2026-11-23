// test/web-hardening.test.js — server-level error handling and cookie parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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
