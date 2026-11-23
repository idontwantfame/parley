import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuildVoiceGate, AUTO_LEAVE_GRACE_MS, JOIN_FAILURE_BACKOFF_MS } from '../src/voice/guild-voice-gate.js';

// Manual timer harness so grace periods run instantly and deterministically.
function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return { id, unref() {} }; },
    clearTimer: (handle) => { timers.delete(handle?.id); },
    fireAll: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    pending: () => [...timers.values()],
  };
}

test('grace and backoff are named, sensible defaults', () => {
  assert.ok(AUTO_LEAVE_GRACE_MS >= 20_000 && AUTO_LEAVE_GRACE_MS <= 30_000);
  assert.ok(JOIN_FAILURE_BACKOFF_MS >= 30_000);
});

test('only one join per guild at a time, keyed by guild not channel', () => {
  const gate = new GuildVoiceGate();
  assert.equal(gate.tryBeginJoin('g', 'A'), true);
  assert.equal(gate.tryBeginJoin('g', 'B'), false);
  assert.equal(gate.tryBeginJoin('g', 'A'), false);
  assert.equal(gate.tryBeginJoin('other', 'C'), true, 'other guilds are independent');
  assert.equal(gate.joiningChannel('g'), 'A');
  gate.endJoin('g');
  assert.equal(gate.joiningChannel('g'), null);
  assert.equal(gate.tryBeginJoin('g', 'B'), true);
});

test('a stop during the join window is remembered and reported when the join ends', () => {
  const gate = new GuildVoiceGate();
  assert.equal(gate.requestCancel('g', 'A'), false, 'nothing joining → nothing to cancel');
  gate.tryBeginJoin('g', 'A');
  assert.equal(gate.requestCancel('g', 'B'), false, 'a stop for another channel does not cancel this join');
  assert.equal(gate.isCancelled('g'), false);
  assert.equal(gate.requestCancel('g', 'A'), true);
  assert.equal(gate.isCancelled('g'), true);
  gate.endJoin('g');
  assert.equal(gate.isCancelled('g'), false, 'the cancel does not leak into the next join');
});

test('a failed join backs off auto-join for that channel for a while', () => {
  let now = 1_000;
  const gate = new GuildVoiceGate({ now: () => now, backoffMs: 60_000 });
  assert.equal(gate.inBackoff('g', 'A'), false);
  gate.recordFailure('g', 'A');
  assert.equal(gate.inBackoff('g', 'A'), true);
  assert.equal(gate.inBackoff('g', 'B'), false);
  now += 59_999;
  assert.equal(gate.inBackoff('g', 'A'), true);
  now += 1;
  assert.equal(gate.inBackoff('g', 'A'), false);
  gate.recordFailure('g', 'A');
  gate.clearFailure('g', 'A');
  assert.equal(gate.inBackoff('g', 'A'), false);
});

test('auto-leave fires only after the grace period, once', async () => {
  const timers = fakeTimers();
  const gate = new GuildVoiceGate({ ...timers, graceMs: 25_000 });
  let left = 0;
  assert.equal(gate.scheduleLeave('g', 'A', () => { left++; }), true);
  assert.equal(gate.scheduleLeave('g', 'A', () => { left++; }), false, 'already pending');
  assert.equal(gate.pendingLeave('g'), 'A');
  assert.equal(timers.pending()[0].ms, 25_000);
  assert.equal(left, 0);
  timers.fireAll();
  await new Promise((r) => setImmediate(r)); // runs in a contained microtask
  assert.equal(left, 1);
  assert.equal(gate.pendingLeave('g'), null);
});

test('participants returning cancels the pending auto-leave', () => {
  const timers = fakeTimers();
  const gate = new GuildVoiceGate(timers);
  let left = 0;
  gate.scheduleLeave('g', 'A', () => { left++; });
  assert.equal(gate.cancelLeave('g'), true);
  assert.equal(gate.cancelLeave('g'), false);
  timers.fireAll();
  assert.equal(left, 0);
});

test('clear() drops every pending timer and join (bot shutdown)', () => {
  const timers = fakeTimers();
  const gate = new GuildVoiceGate(timers);
  let left = 0;
  gate.scheduleLeave('g1', 'A', () => { left++; });
  gate.scheduleLeave('g2', 'B', () => { left++; });
  gate.tryBeginJoin('g3', 'C');
  gate.clear();
  assert.equal(timers.pending().length, 0);
  assert.equal(gate.joiningChannel('g3'), null);
  assert.equal(left, 0);
});

test('a guild is marked busy while a recording is being stopped (flush window)', () => {
  const gate = new GuildVoiceGate();
  assert.equal(gate.isLeaving('g'), false);
  gate.beginLeave('g');
  gate.beginLeave('g'); // overlapping stops (e.g. /leave racing auto-leave)
  assert.equal(gate.isLeaving('g'), true);
  gate.endLeave('g');
  assert.equal(gate.isLeaving('g'), true, 'still one stop in flight');
  gate.endLeave('g');
  assert.equal(gate.isLeaving('g'), false);
  assert.equal(gate.isLeaving('other'), false);
});

test('a throwing or rejecting auto-leave callback is logged, never an unhandled rejection', async () => {
  const timers = fakeTimers();
  const logged = [];
  const gate = new GuildVoiceGate({ ...timers, log: { error: (...a) => logged.push(a.join(' ')) } });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    gate.scheduleLeave('g1', 'A', () => { throw new Error('sync boom'); });
    gate.scheduleLeave('g2', 'B', async () => { throw new Error('async boom'); });
    timers.fireAll();
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
    assert.match(logged.join('\n'), /sync boom/);
    assert.match(logged.join('\n'), /async boom/);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
