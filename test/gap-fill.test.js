import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGapFill, createGapFiller, PCM_BYTES_PER_MS, GAP_JITTER_MS, MAX_GAP_FILL_MS } from '../src/voice/gap-fill.js';

const FRAME = 20 * PCM_BYTES_PER_MS; // one 20 ms opus frame decoded to s16le/16k/mono = 640 bytes

// Feed arrival times through the pure planner the way the Transform does.
function run(arrivals, opts) {
  let state = { originMs: null, writtenBytes: 0 };
  const fills = [];
  for (const at of arrivals) {
    const { fillBytes, originMs } = planGapFill(state, at, opts);
    fills.push(fillBytes);
    state = { originMs, writtenBytes: state.writtenBytes + fillBytes + FRAME };
  }
  return { fills, state };
}

test('constants: 16 kHz mono s16le, a jitter allowance beyond the 20 ms cadence, a per-gap cap', () => {
  assert.equal(PCM_BYTES_PER_MS, 32);
  assert.equal(GAP_JITTER_MS, 60);
  assert.equal(MAX_GAP_FILL_MS, 1000);
});

test('a steady 20 ms packet cadence inserts nothing', () => {
  const { fills } = run([0, 20, 40, 60, 80, 100].map((t) => 1000 + t));
  assert.deepEqual(fills, [0, 0, 0, 0, 0, 0]);
});

test('ordinary network jitter (within the threshold) inserts nothing', () => {
  const { fills } = run([0, 20, 95, 100, 120].map((t) => 1000 + t));
  assert.deepEqual(fills, [0, 0, 0, 0, 0]);
});

test('a mid-turn pause is restored as silence so the turn keeps wall-clock length', () => {
  // Speaker talks 40 ms, pauses ~500 ms (Discord sends no packets), talks again.
  const { fills, state } = run([0, 20, 540, 560].map((t) => 1000 + t));
  assert.deepEqual(fills, [0, 0, 500 * PCM_BYTES_PER_MS, 0]);
  // Total PCM now spans the real 580 ms instead of 80 ms.
  assert.equal(state.writtenBytes / PCM_BYTES_PER_MS, 580);
});

test('each gap is capped so a stall cannot balloon the file', () => {
  const { fills } = run([0, 5000, 5020], { maxFillMs: 1000 });
  assert.equal(fills[1], 1000 * PCM_BYTES_PER_MS);
  assert.equal(fills[2], 0, 'the excess beyond the cap is forgiven, not re-filled on the next packet');
});

test('a delayed burst does not compound: drift corrects at the next real pause', () => {
  // Packets 2-6 delayed 100 ms then arrive together; then a real 300 ms pause.
  const { fills, state } = run([0, 20, 140, 141, 142, 143, 144, 160, 480].map((t) => 1000 + t));
  assert.equal(fills[2], 100 * PCM_BYTES_PER_MS);
  // After the pause the PCM length is back in step with the wall clock.
  assert.ok(Math.abs(state.writtenBytes / PCM_BYTES_PER_MS - 500) <= 20);
});

test('fill sizes are whole samples (even byte counts)', () => {
  const { fills } = run([0, 20, 123.3, 300.77]);
  for (const f of fills) assert.equal(f % 2, 0);
});

test('createGapFiller inserts zero samples before a late chunk', async () => {
  const times = [0, 20, 520];
  const filler = createGapFiller({ now: () => times.shift() });
  const out = [];
  filler.on('data', (d) => out.push(d));
  for (let i = 0; i < 3; i++) filler.write(Buffer.alloc(FRAME, 7));
  filler.end();
  await new Promise((r) => filler.on('end', r));
  const all = Buffer.concat(out);
  assert.equal(all.length, 3 * FRAME + 480 * PCM_BYTES_PER_MS);
  // The inserted gap sits between the 2nd and 3rd frame and is pure silence.
  const gap = all.subarray(2 * FRAME, 2 * FRAME + 480 * PCM_BYTES_PER_MS);
  assert.ok(gap.every((b) => b === 0));
  assert.equal(all[all.length - 1], 7);
});
