// The ffmpeg runner for imports and recording archives: noisy decoders must
// not kill it (only the end of stderr is kept), and failures keep the facts
// the callers report (missing binary, timeout, last error line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFMPEG_INPUT_GUARD, runFfmpeg } from '../src/voice/ffmpeg.js';

const node = process.execPath;

test('a command writing megabytes to stderr still succeeds', async () => {
  const script = "for (let i = 0; i < 4000; i++) process.stderr.write('x'.repeat(1000) + '\\n');";
  const result = await runFfmpeg(node, ['-e', script], { timeout: 20_000 });
  assert.ok(result.stderr.length < 64 * 1024, 'only the end of stderr is kept');
});

test('a failure rejects with the last stderr lines and the exit code', async () => {
  const script = "process.stderr.write('noise\\n'.repeat(1000) + 'Invalid data found when processing input\\n'); process.exit(1);";
  const err = await runFfmpeg(node, ['-e', script], { timeout: 20_000 }).catch((e) => e);
  assert.equal(err.code, 1);
  assert.match(err.stderr.trim().split('\n').pop(), /Invalid data found/);
});

test('a missing binary rejects with ENOENT, a slow run is killed at the timeout', async () => {
  const missing = await runFfmpeg('parley-no-such-ffmpeg', [], { timeout: 1000 }).catch((e) => e);
  assert.equal(missing.code, 'ENOENT');
  const slow = await runFfmpeg(node, ['-e', 'setTimeout(() => {}, 10_000)'], { timeout: 100 }).catch((e) => e);
  assert.equal(slow.killed, true);
});

test('inputs are opened with only local file and pipe protocols', () => {
  assert.deepEqual(FFMPEG_INPUT_GUARD, ['-protocol_whitelist', 'file,pipe']);
});
