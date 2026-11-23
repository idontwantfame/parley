import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, computeTalkTime, formatMs } from '../src/pipeline/summarize.js';

const utterances = [
  { displayName: 'Alice', startMs: 2000, endMs: 4000, text: 'second' },
  { displayName: 'Bob', startMs: 0, endMs: 1000, text: 'first' },
  { displayName: 'Alice', startMs: 5000, endMs: 6000, text: 'third word here' },
];

test('formatMs renders mm:ss', () => {
  assert.equal(formatMs(0), '00:00');
  assert.equal(formatMs(65000), '01:05');
});

test('buildTranscript sorts by startMs and labels speakers', () => {
  // Alice's second line starts > TURN_MERGE_GAP_MS after her first ends, so it
  // stays a separate turn (back-to-back lines merge; see the test below).
  const t = buildTranscript([...utterances.slice(0, 2), { ...utterances[2], startMs: 7000, endMs: 8000 }]);
  assert.equal(t, '[00:00] Bob: first\n[00:02] Alice: second\n[00:07] Alice: third word here');
});

test('buildTranscript stamps relative to the first utterance, not epoch', () => {
  const origin = 1_788_190_209_302;
  const t = buildTranscript([
    { displayName: 'Joy', startMs: origin, endMs: origin + 900, text: 'hey' },
    { displayName: 'Ahmad', startMs: origin + 65_000, endMs: origin + 66_000, text: 'hi' },
  ]);
  assert.equal(t, '[00:00] Joy: hey\n[01:05] Ahmad: hi');
});

test('buildTranscript of no utterances is empty', () => {
  assert.equal(buildTranscript([]), '');
});

test('computeTalkTime aggregates ms, words, pct per speaker', () => {
  const stats = computeTalkTime(utterances);
  const alice = stats.find((s) => s.displayName === 'Alice');
  const bob = stats.find((s) => s.displayName === 'Bob');
  assert.equal(alice.ms, 3000);     // (4000-2000)+(6000-5000)
  assert.equal(alice.words, 4);     // "second"(1) + "third word here"(3)
  assert.equal(bob.ms, 1000);
  assert.equal(alice.pct + bob.pct, 100);
});

test('buildTranscript merges back-to-back lines from one speaker into a single turn', () => {
  // Stored transcripts are sentence-level (for seeking); the summarizer should
  // still get compact speaker turns, not a label on every sentence.
  const u = (displayName, startMs, endMs, text) => ({ displayName, startMs, endMs, text });
  const out = buildTranscript([u('Ann', 0, 1000, 'Hi.'), u('Ann', 1200, 2000, 'How are you?'),
    u('Bob', 2100, 3000, 'Fine.'), u('Ann', 3100, 4000, 'Good.'), u('Ann', 9000, 9500, 'Later.')]);
  assert.equal(out, '[00:00] Ann: Hi. How are you?\n[00:02] Bob: Fine.\n[00:03] Ann: Good.\n[00:09] Ann: Later.');
});
