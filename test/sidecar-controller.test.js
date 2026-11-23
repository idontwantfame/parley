import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SidecarController } from '../src/sidecar-controller.js';

// A fake child process: an EventEmitter with stdout/stderr streams + kill().
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (sig) => { child.killed = true; child.signal = sig; child.emit('exit', 0); return true; };
  return child;
}

// Build a controller with controllable health responses + spawn capture.
function make({ healthSeq = [], exists = () => true } = {}) {
  let healthIdx = 0;
  const spawned = [];
  const fetch = async () => {
    const ok = healthSeq[Math.min(healthIdx, healthSeq.length - 1)] ?? false;
    healthIdx++;
    if (!ok) throw new Error('ECONNREFUSED');
    return { ok: true };
  };
  const lastChild = { ref: null };
  const spawn = (cmd, args, opts) => {
    const child = fakeChild();
    spawned.push({ cmd, args, opts, child });
    lastChild.ref = child;
    return child;
  };
  const sc = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { spawn, fetch, exists } });
  return { sc, spawned, lastChild };
}

test('managed() requires a local url and an installed venv', () => {
  const local = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { exists: () => true } });
  assert.equal(local.managed(), true);
  const remote = new SidecarController({ sttUrl: 'http://stt:8000', deps: { exists: () => true } });
  assert.equal(remote.managed(), false);
  const noVenv = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { exists: () => false } });
  assert.equal(noVenv.managed(), false);
});

test('start() adopts an already-healthy sidecar without spawning', async () => {
  const { sc, spawned } = make({ healthSeq: [true] });
  const r = await sc.start();
  assert.equal(r.ok, true);
  assert.equal(sc.state, 'running');
  assert.equal(sc.external, true);
  assert.equal(spawned.length, 0);
});

test('start() spawns when nothing is listening, then becomes healthy', async () => {
  // First health check (pre-spawn) fails, subsequent poll succeeds.
  const { sc, spawned } = make({ healthSeq: [false, true] });
  const r = await sc.start({ waitMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(sc.state, 'running');
  assert.equal(sc.external, false);
  assert.equal(spawned.length, 1);
  // Passes STT_HOST/PORT derived from the url.
  assert.equal(spawned[0].opts.env.STT_PORT, '8000');
  assert.equal(spawned[0].opts.env.STT_HOST, '127.0.0.1');
});

test('start() refuses when unmanaged (remote url)', async () => {
  const sc = new SidecarController({ sttUrl: 'http://stt:8000', deps: { exists: () => true, fetch: async () => { throw new Error('down'); } } });
  const r = await sc.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /managed elsewhere/);
});

test('start() reports a helpful error when the venv is missing', async () => {
  const sc = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { exists: () => false, fetch: async () => { throw new Error('down'); } } });
  const r = await sc.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed/);
});

test('stop() kills a spawned child', async () => {
  const { sc, lastChild } = make({ healthSeq: [false, true] });
  await sc.start({ waitMs: 2000 });
  const child = lastChild.ref;
  const r = await sc.stop();
  assert.equal(r.ok, true);
  assert.equal(sc.state, 'stopped');
  assert.equal(child.killed, true);
});

test('stop() leaves an external sidecar running', async () => {
  const { sc } = make({ healthSeq: [true] });
  await sc.start();
  assert.equal(sc.external, true);
  const r = await sc.stop();
  assert.equal(sc.state, 'stopped');
  assert.match(r.note || '', /left running/i);
});

test('an unexpected child exit flips state to error', async () => {
  const { sc, lastChild } = make({ healthSeq: [false, true] });
  await sc.start({ waitMs: 2000 });
  assert.equal(sc.state, 'running');
  // Simulate a crash (not via stop(), so this.child is still set).
  lastChild.ref.emit('exit', 1);
  assert.equal(sc.state, 'error');
  assert.match(sc.error, /exited/);
});

test('status() snapshot exposes the fields the UI reads', async () => {
  const { sc } = make({ healthSeq: [true] });
  await sc.start();
  const st = sc.status();
  assert.deepEqual(Object.keys(st).sort(),
    ['batchSize', 'compute', 'device', 'error', 'external', 'log', 'managed', 'model', 'running', 'state', 'url'].sort());
  assert.equal(st.running, true);
  assert.equal(st.managed, true);
});

test('status() surfaces device/compute/batch from the /health body', async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', model: 'small', device: 'cuda', compute: 'float16', batch_size: 8 }) });
  const sc = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { fetch, exists: () => true } });
  await sc.start();
  const st = sc.status();
  assert.equal(st.device, 'cuda');
  assert.equal(st.compute, 'float16');
  assert.equal(st.model, 'small');
  assert.equal(st.batchSize, 8);
});

test('status() leaves health fields null when /health returns no JSON', async () => {
  // Older sidecar / non-JSON health: fields stay null, no crash.
  const { sc } = make({ healthSeq: [true] });
  await sc.start();
  const st = sc.status();
  assert.equal(st.device, null);
  assert.equal(st.batchSize, null);
});

// ── single-flight start, health timeout, live URL ────────────────────────────
function makeSlow({ healthy = () => false } = {}) {
  const spawned = [];
  const fetch = async () => { if (!healthy()) throw new Error('ECONNREFUSED'); return { ok: true }; };
  const spawn = () => { const child = fakeChild(); spawned.push(child); return child; };
  const sc = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { spawn, fetch, exists: () => true, pollMs: 5 } });
  return { sc, spawned };
}

test('a health timeout keeps tracking the child so stop() can still kill it', async () => {
  const { sc, spawned } = makeSlow();
  const r = await sc.start({ waitMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /healthy in time/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killed, false, 'a first-run model download keeps going');
  await sc.stop();
  assert.equal(spawned[0].killed, true, 'not orphaned');
});

test('starting again after a health timeout waits on the same child instead of spawning another', async () => {
  let up = false;
  const { sc, spawned } = makeSlow({ healthy: () => up });
  await sc.start({ waitMs: 20 });
  // Still downloading the model when the user clicks Start again.
  const again = sc.start({ waitMs: 500 });
  setTimeout(() => { up = true; }, 30);
  const r = await again;
  assert.equal(r.ok, true);
  assert.equal(spawned.length, 1, 'no second process fighting over the port');
  assert.equal(spawned[0].killed, false);
  assert.equal(sc.state, 'running');
});

test('concurrent start() calls share one spawn', async () => {
  let up = false;
  const { sc, spawned } = makeSlow({ healthy: () => up });
  const a = sc.start({ waitMs: 500 });
  const b = sc.start({ waitMs: 500 });
  setTimeout(() => { up = true; }, 30);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(spawned.length, 1);
});

test('the STT URL is read live, so a changed connection setting reaches the controller', () => {
  let url = 'http://127.0.0.1:8000';
  const sc = new SidecarController({ sttUrl: () => url, deps: { exists: () => true } });
  assert.equal(sc.managed(), true);
  assert.equal(sc.status().url, 'http://127.0.0.1:8000');
  url = 'http://stt:9000';
  assert.equal(sc.managed(), false);
  assert.equal(sc.status().url, 'http://stt:9000');
});

test('a spawn error forgets the dead child so the next start spawns again', async () => {
  const { sc, spawned } = makeSlow();
  const first = sc.start({ waitMs: 200 });
  while (!spawned.length) await new Promise((r) => setTimeout(r, 1));
  spawned[0].emit('error', new Error('spawn ENOENT'));
  assert.equal((await first).ok, false);
  await sc.start({ waitMs: 20 });
  assert.equal(spawned.length, 2);
});

test('stop() during the health wait is not overwritten by the timeout', async () => {
  const { sc } = makeSlow();
  const pending = sc.start({ waitMs: 60 });
  await new Promise((r) => setTimeout(r, 10));
  await sc.stop();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(sc.state, 'stopped');
});

test('stop() during the initial health probe prevents the spawn (no orphan)', async () => {
  let releaseProbe;
  const spawned = [];
  let probes = 0;
  const fetch = () => (probes++ === 0
    ? new Promise((_, reject) => { releaseProbe = () => reject(new Error('ECONNREFUSED')); })
    : Promise.reject(new Error('ECONNREFUSED')));
  const spawn = () => { const c = fakeChild(); spawned.push(c); return c; };
  const sc = new SidecarController({ sttUrl: 'http://127.0.0.1:8000', deps: { spawn, fetch, exists: () => true, pollMs: 5 } });
  const starting = sc.start({ waitMs: 50 });
  await sc.stop();
  releaseProbe();
  const r = await starting;
  assert.equal(r.ok, false);
  assert.equal(spawned.length, 0);
  assert.equal(sc.state, 'stopped');
});
