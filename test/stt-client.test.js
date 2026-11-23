import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeFile } from '../src/adapters/stt-client.js';

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
}

const fakeRead = async () => Buffer.from('RIFFfake');

test('transcribeFile returns parsed body on success', async () => {
  const fetchImpl = fakeFetch([{ ok: true, status: 200, body: { text: 'hi', words: [] } }]);
  const out = await transcribeFile('/tmp/a.wav', { model: 'small', language: 'auto' },
    { baseUrl: 'http://x', fetchImpl, readFile: fakeRead });
  assert.equal(out.text, 'hi');
});

test('transcribeFile retries once then succeeds', async () => {
  const fetchImpl = fakeFetch([new Error('boom'), { ok: true, status: 200, body: { text: 'ok', words: [] } }]);
  const out = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 });
  assert.equal(out.text, 'ok');
});

test('transcribeFile throws after exhausting retries', async () => {
  const fetchImpl = fakeFetch([new Error('boom'), new Error('boom2')]);
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 }),
    /boom2/
  );
});

test('transcribeFile does NOT retry a 4xx (client error)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 400, json: async () => ({}) }; };
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 3, backoffMs: 0 }),
    /HTTP 400/
  );
  assert.equal(calls, 1, 'a 4xx must fail fast without re-uploading');
});

test('transcribeFile DOES retry a 5xx (transient server error)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ text: 'recovered', words: [] }) };
  };
  const out = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 });
  assert.equal(out.text, 'recovered');
  assert.equal(calls, 2);
});

test('transcribeFile surfaces a timeout abort error after retries', async () => {
  // fetchImpl that always throws a TimeoutError-like error, ignoring the signal
  const fetchImpl = async () => { throw new Error('The operation timed out'); };
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: async () => Buffer.from('x'), retries: 1, timeoutMs: 5 }),
    /timed out/
  );
});

test('transcribeFile does NOT retry after a timeout (the sidecar may still be working on it)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 3, backoffMs: 0, timeoutMs: 1000 }),
    /timed out after 1s/,
  );
  assert.equal(calls, 1, 'a timed-out upload must not be re-sent');
});

test('transcribeFile reports the sidecar error detail and drains the response body', async () => {
  let drained = 0;
  const fetchImpl = async () => ({
    ok: false, status: 400,
    text: async () => { drained++; return '{"detail":"Unsupported model: huge"}'; },
  });
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 }),
    /STT sidecar HTTP 400: Unsupported model: huge$/,
  );
  assert.equal(drained, 1);
});

test('transcribeFile streams a real file to a slow sidecar and gives up once at the timeout', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'parley-stt-'));
  const path = join(dir, 'a.wav');
  writeFileSync(path, Buffer.alloc(5000, 1));
  let requests = 0;
  const timers = [];
  const server = createServer((req, res) => {
    requests++;
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; });
    req.on('end', () => {
      const delay = req.url.includes('slow') ? 2500 : 0;
      timers.push(setTimeout(() => res.end(JSON.stringify({ text: `got ${bytes}`, words: [] })), delay));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await transcribeFile(path, {}, { baseUrl: base, backoffMs: 0 });
    assert.match(ok.text, /^got \d{4,}$/);
    requests = 0;
    await assert.rejects(transcribeFile(path, {}, { baseUrl: `${base}/slow`, retries: 2, backoffMs: 0, timeoutMs: 300 }), /timed out/);
    assert.equal(requests, 1);
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
