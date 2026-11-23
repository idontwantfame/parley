import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchWithTimeouts, isTimeoutError, fileBlob } from '../src/adapters/http.js';

// A server that only sends response headers once the "work" is done — exactly
// how the STT sidecar and Ollama (stream:false) behave.
async function slowServer(delayMs) {
  const timers = new Set();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const t = setTimeout(() => {
        timers.delete(t);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ bytes: Buffer.concat(chunks).length, type: req.headers['content-type'] }));
      }, delayMs);
      timers.add(t);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests: () => requests,
    close: () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

test('fetchWithTimeouts makes the response-header wait follow timeoutMs, not undici\'s 300s default', async () => {
  const srv = await slowServer(2500);
  try {
    // No AbortSignal: only the dispatcher's headersTimeout can end this early.
    // Node's stock fetch would happily wait the 2.5s (its limit is 300s).
    const started = Date.now();
    const err = await fetchWithTimeouts(300)(srv.url, { method: 'POST', body: 'x' }).catch((e) => e);
    assert.ok(err instanceof Error, 'expected the request to time out');
    assert.ok(isTimeoutError(err), `not recognised as a timeout: ${err.cause?.code || err.message}`);
    assert.ok(Date.now() - started < 2400, 'timed out by the dispatcher, before the server answered');
  } finally { await srv.close(); }
});

test('fetchWithTimeouts uploads FormData with a file-backed Blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-http-'));
  const srv = await slowServer(10);
  try {
    const path = join(dir, 'a.wav');
    writeFileSync(path, Buffer.alloc(100_000, 7));
    const form = new FormData();
    form.append('file', await fileBlob(path), 'a.wav');
    form.append('model', 'small');
    const res = await fetchWithTimeouts(5000)(srv.url, { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(res.ok, true);
    assert.match(body.type, /^multipart\/form-data; boundary=/);
    assert.ok(body.bytes > 100_000, 'the whole file was sent');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isTimeoutError recognises abort-signal and undici header/body timeouts only', () => {
  assert.equal(isTimeoutError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.equal(isTimeoutError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })), true);
  assert.equal(isTimeoutError(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })), true);
  assert.equal(isTimeoutError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), false);
  assert.equal(isTimeoutError(new Error('boom')), false);
  assert.equal(isTimeoutError(null), false);
});

test('fileBlob uses an injected readFile when given (tests / in-memory audio)', async () => {
  const blob = await fileBlob('/nowhere.wav', { readFile: async () => Buffer.from('RIFF') });
  assert.equal(await blob.text(), 'RIFF');
});
