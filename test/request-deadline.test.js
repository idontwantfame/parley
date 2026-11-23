// Request time limits: a whole-request deadline on every route (Node's default
// 5 minutes), extendable only by a route that needs it (recording uploads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import net from 'node:net';
import { createServer } from 'node:http';
import {
  applyServerTimeouts, requestDeadline, REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, IDLE_SOCKET_TIMEOUT_MS,
} from '../src/web/request-deadline.js';

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

// Send `head` + `first` bytes, optionally the rest after `pauseMs`; resolve
// with whatever the server sent back once it closes (or after `waitMs`).
function trickle(port, { path, length, first, rest = null, pauseMs = 0, waitMs = 1500 }) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let reply = '';
    const done = () => { clearTimeout(timer); socket.destroy(); resolve(reply); };
    const timer = setTimeout(done, waitMs);
    socket.on('data', (chunk) => { reply += chunk.toString(); });
    socket.on('close', done);
    socket.on('error', done);
    socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`);
    socket.write(first);
    if (rest) setTimeout(() => socket.write(rest), pauseMs);
  });
}

function app({ timeoutMs, extendTo = null }) {
  const a = express();
  a.use(requestDeadline({ timeoutMs }));
  a.post('/upload', (req, res) => {
    if (extendTo) req.extendDeadline(extendTo);
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; });
    req.on('end', () => res.json({ bytes }));
  });
  return a;
}

test('a request body that does not arrive by the deadline gets 408 and the connection is closed', async (t) => {
  const port = await serve(t, app({ timeoutMs: 80 }));
  const reply = await trickle(port, { path: '/upload', length: 100, first: 'x'.repeat(10) });
  assert.match(reply, /^HTTP\/1\.1 408/);
  assert.match(reply, /Connection: close/i);
});

test('a request that arrives in time is answered normally', async (t) => {
  const port = await serve(t, app({ timeoutMs: 500 }));
  const reply = await trickle(port, { path: '/upload', length: 20, first: 'x'.repeat(10), rest: 'y'.repeat(10), pauseMs: 20, waitMs: 300 });
  assert.match(reply, /^HTTP\/1\.1 200/);
  assert.match(reply, /"bytes":20/);
});

test('a route can extend its own deadline (a long upload)', async (t) => {
  const port = await serve(t, app({ timeoutMs: 80, extendTo: 2000 }));
  const reply = await trickle(port, { path: '/upload', length: 20, first: 'x'.repeat(10), rest: 'y'.repeat(10), pauseMs: 250, waitMs: 800 });
  assert.match(reply, /^HTTP\/1\.1 200/);
  assert.match(reply, /"bytes":20/);
});

test('server limits: no server-wide long request deadline; headers and idle sockets are bounded', () => {
  const server = applyServerTimeouts(createServer());
  assert.equal(REQUEST_TIMEOUT_MS, 5 * 60 * 1000, "Node's default whole-request deadline");
  assert.equal(server.requestTimeout, 0, 'enforced per request by requestDeadline instead');
  assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.ok(HEADERS_TIMEOUT_MS <= 60_000);
  assert.equal(server.timeout, IDLE_SOCKET_TIMEOUT_MS);
  assert.ok(IDLE_SOCKET_TIMEOUT_MS > 0 && IDLE_SOCKET_TIMEOUT_MS <= 5 * 60 * 1000);
});
