import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackRegistry } from '../src/voice/capture.js';

test('TrackRegistry records and lists finished tracks', () => {
  const reg = new TrackRegistry();
  reg.begin('u1', 'Alice', 1000, '/audio/1/u1_1000.pcm');
  reg.begin('u2', 'Bob', 1500, '/audio/1/u2_1500.pcm');
  reg.finish('u1');
  reg.finish('u2');
  const tracks = reg.list();
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.displayName).sort(), ['Alice', 'Bob']);
  assert.equal(tracks[0].pcmPath.endsWith('.pcm'), true);
});

test('TrackRegistry isActive prevents duplicate begin', () => {
  const reg = new TrackRegistry();
  reg.begin('u1', 'Alice', 1000, '/p.pcm');
  assert.equal(reg.isActive('u1'), true);
  assert.equal(reg.isActive('u2'), false);
});

// ── attachCapture wiring: listener detach + onSpeaker (needs fakes) ────────────
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachCapture } from '../src/voice/capture.js';

// Minimal stand-ins for the discord.js voice receiver + guild so we can drive
// speaking-start events deterministically without a live connection. subscribe
// returns a stream that emits 'end' on the next tick so tracks finish cleanly.
function fakeConnection() {
  const speaking = new EventEmitter();
  return {
    receiver: {
      speaking,
      subscribe() {
        const s = new EventEmitter();
        s.pipe = () => s;            // opusStream.pipe(decoder).pipe(out)
        s.destroy = () => {};
        setImmediate(() => s.emit('end'));
        return s;
      },
    },
  };
}
function fakeGuild(members) {
  return { members: { cache: { get: (id) => members[id] } } };
}

test('stopAll detaches the speaking listener so post-stop speech is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap-'));
  try {
    const connection = fakeConnection();
    const guild = fakeGuild({ u1: { displayName: 'Alice', user: { bot: false } } });
    const { TrackRegistry } = await import('../src/voice/capture.js');
    const registry = new TrackRegistry();
    const { stopAll } = attachCapture({ connection, guild, audioDir: dir, registry });

    await stopAll();
    // A speaking-start AFTER stopAll must not open a new (untracked) stream.
    connection.receiver.speaking.emit('start', 'u1');
    await new Promise((r) => setImmediate(r));
    assert.equal(registry.isActive('u1'), false);
    assert.equal(registry.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('onSpeaker fires for a member who first speaks (latecomer attendee capture)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap2-'));
  try {
    const connection = fakeConnection();
    const guild = fakeGuild({ u9: { displayName: 'Latecomer', user: { bot: false } } });
    const { TrackRegistry } = await import('../src/voice/capture.js');
    const registry = new TrackRegistry();
    const seen = [];
    attachCapture({ connection, guild, audioDir: dir, registry, onSpeaker: (id, name) => seen.push([id, name]) });

    connection.receiver.speaking.emit('start', 'u9');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [['u9', 'Latecomer']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A throw while starting a track (e.g. the native opus module failing to load
// after a system libc upgrade) must NOT escape the speaking-start listener and
// crash the whole process mid-meeting. Regression for the glibc-2.44 opus crash.
test('a throwing track start is swallowed and does not crash the emitter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap3-'));
  try {
    const connection = fakeConnection();
    // subscribe() throws to simulate opus/decoder construction blowing up.
    connection.receiver.subscribe = () => { throw new Error('Cannot find module opus.node'); };
    const guild = fakeGuild({ u1: { displayName: 'Alice', user: { bot: false } } });
    const { TrackRegistry } = await import('../src/voice/capture.js');
    const registry = new TrackRegistry();
    attachCapture({ connection, guild, audioDir: dir, registry });

    // If the throw escaped the listener this would take the process down.
    assert.doesNotThrow(() => connection.receiver.speaking.emit('start', 'u1'));
    await new Promise((r) => setImmediate(r));
    assert.equal(registry.isActive('u1'), false);
    assert.equal(registry.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── track lifecycle: write errors + flush on end (openTrack) ───────────────────
import { PassThrough, Readable } from 'node:stream';
import { createWriteStream, statSync, existsSync } from 'node:fs';
import { openTrack } from '../src/voice/capture.js';

const quietLog = { warn() {}, error() {}, log() {} };
function opusSource() { return new Readable({ objectMode: true, read() {} }); }

test('a PCM write/open error does not crash the process and still settles the track', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap4-'));
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const opus = opusSource();
    const errors = [];
    const log = { ...quietLog, error: (...a) => errors.push(a.join(' ')) };
    // Opening into a missing directory fails exactly like ENOSPC/EACCES/EMFILE would.
    const out = createWriteStream(join(dir, 'gone', 'u1_1.pcm'));
    const track = openTrack({ opusStream: opus, decoder: new PassThrough(), filler: new PassThrough(), out, label: 'meeting 7 user u1', log });
    opus.push(Buffer.alloc(640));
    const { bytesWritten } = await track.closed;
    assert.equal(bytesWritten, 0);
    assert.equal(uncaught.length, 0);
    assert.match(errors.join('\n'), /meeting 7 user u1/);
    assert.equal(opus.destroyed, true, 'the receive stream is released');
  } finally {
    process.off('uncaughtException', onUncaught);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() flushes audio still buffered under backpressure instead of dropping it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap5-'));
  try {
    const opus = opusSource();
    const path = join(dir, 'u1_1.pcm');
    const track = openTrack({ opusStream: opus, decoder: new PassThrough(), filler: new PassThrough(), out: createWriteStream(path), label: 't', log: quietLog });
    for (let i = 0; i < 2000; i++) opus.push(Buffer.alloc(640, i % 256));
    await new Promise((r) => setImmediate(r));
    const { bytesWritten } = await track.stop();
    assert.equal(bytesWritten, 2000 * 640);
    assert.equal(statSync(path).size, 2000 * 640);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop() right after packets arrive (same tick) still keeps them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap6-'));
  try {
    const opus = opusSource();
    const path = join(dir, 'u1_1.pcm');
    const track = openTrack({ opusStream: opus, decoder: new PassThrough(), filler: new PassThrough(), out: createWriteStream(path), label: 't', log: quietLog });
    for (let i = 0; i < 50; i++) opus.push(Buffer.alloc(640, 1));
    await track.stop();
    assert.equal(statSync(path).size, 50 * 640);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a natural end of the speaking turn flushes everything to disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap7-'));
  try {
    const opus = opusSource();
    const path = join(dir, 'u1_1.pcm');
    const track = openTrack({ opusStream: opus, decoder: new PassThrough(), filler: new PassThrough(), out: createWriteStream(path), label: 't', log: quietLog });
    for (let i = 0; i < 300; i++) opus.push(Buffer.alloc(640, 2));
    opus.push(null);
    const { bytesWritten } = await track.closed;
    assert.equal(bytesWritten, 300 * 640);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stuck flush is bounded: stop() force-closes after the timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap8-'));
  try {
    const opus = opusSource();
    const decoder = new PassThrough();
    decoder.end = () => decoder; // a decoder that never finishes flushing
    const track = openTrack({ opusStream: opus, decoder, filler: new PassThrough(), out: createWriteStream(join(dir, 'x.pcm')), label: 't', log: quietLog, flushTimeoutMs: 30 });
    const started = Date.now();
    await track.stop();
    assert.ok(Date.now() - started < 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachCapture drops a track whose file could not be written, keeping the meeting alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap9-'));
  try {
    const speaking = new EventEmitter();
    const connection = { receiver: { speaking, subscribe: () => opusSource() } };
    const guild = fakeGuild({ u1: { displayName: 'Alice', user: { bot: false } } });
    const registry = new TrackRegistry();
    const { stopAll } = attachCapture({ connection, guild, audioDir: dir, registry, log: quietLog });
    rmSync(dir, { recursive: true, force: true }); // meeting dir vanishes mid-meeting
    speaking.emit('start', 'u1');
    await stopAll();
    assert.equal(registry.isActive('u1'), false);
    assert.deepEqual(registry.list(), [], 'no phantom track pointing at a missing file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TrackRegistry.discard forgets an active track without listing it', () => {
  const reg = new TrackRegistry();
  reg.begin('u1', 'Alice', 1, '/p.pcm');
  reg.discard('u1');
  assert.equal(reg.isActive('u1'), false);
  assert.deepEqual(reg.list(), []);
});

test('a decoder that fails to construct never leaves a dangling receive subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cap10-'));
  try {
    const speaking = new EventEmitter();
    let subscribed = 0;
    const connection = { receiver: { speaking, subscribe: () => { subscribed++; return opusSource(); } } };
    const guild = fakeGuild({ u1: { displayName: 'Alice', user: { bot: false } } });
    const registry = new TrackRegistry();
    attachCapture({
      connection, guild, audioDir: dir, registry, log: quietLog,
      createDecoder: () => { throw new Error('Cannot find module opus.node'); },
    });
    speaking.emit('start', 'u1');
    assert.equal(subscribed, 0, 'nothing subscribed, so the next turn can subscribe fresh');
    assert.equal(registry.isActive('u1'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
