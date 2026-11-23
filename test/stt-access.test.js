// The optional shared access key (STT_API_KEY) on every request Parley makes
// to the sidecar, and waiting politely when the sidecar says it is busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';
import { sidecarCapability, transcribeFile, SIDECAR_KEY_REJECTED, SIDECAR_NEEDS_KEY } from '../src/adapters/stt-client.js';

const fakeRead = async () => Buffer.from('RIFFfake');
const ok = (body = { text: 'ok', words: [] }) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const busy = (retryAfter = '5') => new Response('{"detail":"busy"}', { status: 503, headers: { 'retry-after': retryAfter } });

function withKey(t, key) {
  const previous = config.sttApiKey;
  config.sttApiKey = key;
  t.after(() => { config.sttApiKey = previous; });
}

test('every transcription request carries the access key when one is set', async (t) => {
  withKey(t, 's3cret');
  const seen = [];
  const fetchImpl = async (_url, init) => { seen.push(new Headers(init.headers).get('authorization')); return ok(); };
  await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead });
  await sidecarCapability({ baseUrl: 'http://x', fetchImpl: async (_url, init) => { seen.push(new Headers(init.headers).get('authorization')); return ok({ diarization: { available: true } }); } });
  assert.deepEqual(seen, ['Bearer s3cret', 'Bearer s3cret']);
});

test('without a key no Authorization header is sent', async (t) => {
  withKey(t, undefined);
  let auth = 'unset';
  await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', readFile: fakeRead,
    fetchImpl: async (_url, init) => { auth = new Headers(init.headers).get('authorization'); return ok(); } });
  assert.equal(auth, null);
});

test('a rejected access key is a clear error that is not retried', async (t) => {
  withKey(t, 'wrong');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('{"detail":"Missing or wrong access key."}', { status: 401 }); };
  const err = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 3, backoffMs: 0 }).catch((e) => e);
  assert.equal(calls, 1);
  assert.equal(err.status, 401);
  assert.match(err.message, new RegExp(SIDECAR_KEY_REJECTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(err.userMessage, /access key/);
});

test('other sidecar refusals (too large, unreadable, too long) reach the user with their reason', async () => {
  for (const [status, detail] of [[413, 'Upload is larger than this sidecar accepts.'], [400, "The uploaded file isn't audio this sidecar can read."]]) {
    const fetchImpl = async () => new Response(JSON.stringify({ detail }), { status });
    const err = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 2, backoffMs: 0 }).catch((e) => e);
    assert.equal(err.noRetry, true);
    assert.ok(err.userMessage.includes(detail), err.userMessage);
  }
});

test('a busy sidecar is waited for (Retry-After, with jitter), even with no retries left, without counting as a failure', async () => {
  const waits = [];
  const replies = [busy('2'), busy('2'), ok()];
  const fetchImpl = async () => replies.shift();
  const out = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 0,
    sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  assert.equal(out.text, 'ok');
  assert.equal(waits.length, 2);
  for (const ms of waits) assert.ok(ms >= 2000 && ms <= 3000, `waited ${ms} ms`);
});

test('a sidecar that stays busy is given up on after a bounded number of waits', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return busy('1'); };
  const err = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 0,
    sleep: async () => {}, random: () => 0 }).catch((e) => e);
  assert.ok(calls > 1 && calls <= 11, `calls ${calls}`);
  assert.match(err.message, /busy/);
});

test('a 503 that is not "busy" keeps the ordinary retry behaviour', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('{"detail":"model crashed"}', { status: 503 }); };
  await assert.rejects(transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0,
    sleep: async () => assert.fail('no busy wait') }), /model crashed/);
  assert.equal(calls, 2);
});

test('a sidecar that requires a key Parley does not have is reported as not usable', async (t) => {
  withKey(t, undefined);
  const cap = await sidecarCapability({ baseUrl: 'http://x', fetchImpl: async () => ok({ auth: 'key', diarization: { available: true } }) });
  assert.equal(cap.available, false);
  assert.equal(cap.reason, SIDECAR_NEEDS_KEY);
  withKey(t, 'k');
  const keyed = await sidecarCapability({ baseUrl: 'http://x', fetchImpl: async () => ok({ auth: 'key', diarization: { available: true } }) });
  assert.equal(keyed.available, true);
});

test('a health check refused for the access key says so', async (t) => {
  withKey(t, 'wrong');
  const cap = await sidecarCapability({ baseUrl: 'http://x', fetchImpl: async () => new Response('{"detail":"Missing or wrong access key."}', { status: 401 }) });
  assert.equal(cap.available, false);
  assert.match(cap.reason, /access key/);
});
