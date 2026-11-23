// Summary regeneration status per meeting: finished results expire and the
// map is capped, so it can't grow for the lifetime of the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegenerationState } from '../src/web/regeneration-state.js';

test('a finished regeneration is reported until it expires', () => {
  let t = 0;
  const regen = createRegenerationState({ now: () => t, ttlMs: 1000 });
  regen.start(1);
  assert.deepEqual(regen.get(1), { state: 'running' });
  assert.equal(regen.isRunning(1), true);
  regen.finish(1, { state: 'failed', error: 'The new summary could not be saved.' });
  assert.deepEqual(regen.get(1), { state: 'failed', error: 'The new summary could not be saved.' });
  assert.equal(regen.isRunning(1), false);
  t = 1001;
  assert.equal(regen.get(1), undefined);
  assert.equal(regen.size(), 0);
});

test('a running regeneration never expires', () => {
  let t = 0;
  const regen = createRegenerationState({ now: () => t, ttlMs: 1000 });
  regen.start(7);
  t = 1_000_000;
  assert.deepEqual(regen.get(7), { state: 'running' });
});

test('the map is capped by dropping the oldest finished entries', () => {
  const regen = createRegenerationState({ now: () => 0, ttlMs: 1e9, maxEntries: 3 });
  regen.start(1);
  for (const id of [2, 3, 4, 5]) { regen.start(id); regen.finish(id, { state: 'done' }); }
  assert.equal(regen.size(), 3);
  assert.deepEqual(regen.get(1), { state: 'running' });
  assert.equal(regen.get(2), undefined);
  assert.equal(regen.get(3), undefined);
  assert.deepEqual(regen.get(5), { state: 'done' });
});

test('the ETA uses measured chunk times, then updates with overview timings', () => {
  let t = 100_000;
  const regen = createRegenerationState({ now: () => t });
  regen.start(1);
  regen.update(1, { stage: 'chunks', total: 3, overviewTotal: 2 });
  assert.equal(regen.get(1).progress.estimatedFinishAt, null);

  t += 10_000;
  regen.update(1, { durationMs: 10_000 });
  t += 4_000;
  assert.deepEqual(regen.get(1).progress, {
    stage: 'chunks', total: 3, completed: 1, overviewTotal: 2, overviewCompleted: 0,
    chunkDurationsMs: [10_000], remainingMs: 36_000, estimatedFinishAt: 150_000,
  });

  t += 6_000;
  regen.update(1, { durationMs: 10_000 });
  t += 10_000;
  regen.update(1, { durationMs: 10_000 });
  regen.update(1, { stage: 'overview', total: 2 });
  assert.equal(regen.get(1).progress.estimatedFinishAt, 150_000);
  t += 3_000;
  regen.update(1, { durationMs: 3_000 });
  assert.equal(regen.get(1).progress.overviewCompleted, 1);
  assert.equal(regen.get(1).progress.estimatedFinishAt, 136_000);
  t += 4_000;
  assert.equal(regen.get(1).progress.estimatedFinishAt, null);
  regen.update(1, { stage: 'fallback' });
  assert.deepEqual(regen.get(1), { state: 'running' });
});
