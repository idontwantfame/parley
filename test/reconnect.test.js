import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { waitForReconnect, RECONNECT_READY_MS } from '../src/voice/reconnect.js';

// A stand-in VoiceConnection: @discordjs/voice's entersState only needs
// `state.status` plus status-named events.
function fakeConnection(status = VoiceConnectionStatus.Disconnected) {
  const c = new EventEmitter();
  c.state = { status };
  c.to = (next) => { c.state = { status: next }; c.emit(next); };
  return c;
}
const fast = { startMs: 30, readyMs: 60 };

test('the Ready wait after a reconnect starts is bounded (~20 s by default)', () => {
  assert.ok(RECONNECT_READY_MS >= 15_000 && RECONNECT_READY_MS <= 30_000);
});

test('a reconnect that reaches Ready is recovered', async () => {
  const c = fakeConnection();
  const result = waitForReconnect(c, fast);
  setTimeout(() => c.to(VoiceConnectionStatus.Connecting), 5);
  setTimeout(() => c.to(VoiceConnectionStatus.Ready), 15);
  assert.equal(await result, 'ready');
});

test('a disconnect that never starts reconnecting is gone', async () => {
  const c = fakeConnection();
  assert.equal(await waitForReconnect(c, fast), 'gone');
});

test('a reconnect stuck in Signalling/Connecting is reported stuck instead of hanging forever', async () => {
  const c = fakeConnection();
  const result = waitForReconnect(c, fast);
  setTimeout(() => c.to(VoiceConnectionStatus.Signalling), 5);
  assert.equal(await result, 'stuck');
});
