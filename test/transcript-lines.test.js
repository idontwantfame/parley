// Sentence-level transcript lines: each line carries its own time range so the
// dashboard can seek the recording to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptLines, transcribeTracks } from '../src/pipeline/transcribe.js';

const w = (word, start, end) => ({ word, start, end });

test('segments become one line each, trimmed, with empty ones dropped', () => {
  const lines = transcriptLines({ text: 'Hi. How are you?', segments: [
    { start: 0.2, end: 1.1, text: ' Hi.' }, { start: 1.5, end: 3, text: ' How are you? ' }, { start: 3, end: 3.2, text: '  ' }] });
  assert.deepEqual(lines, [{ start: 0.2, end: 1.1, text: 'Hi.' }, { start: 1.5, end: 3, text: 'How are you?' }]);
});

test('without segments, spaced words split at sentence ends and long pauses', () => {
  const lines = transcriptLines({ words: [w(' Hello', 0, 0.4), w(' there.', 0.4, 0.8), w(' Next', 1, 1.3),
    w(' bit', 1.3, 1.6), w(' after', 4, 4.3), w(' pause', 4.3, 4.6)] });
  assert.deepEqual(lines.map((l) => l.text), ['Hello there.', 'Next bit', 'after pause']);
  assert.deepEqual(lines.map((l) => [l.start, l.end]), [[0, 0.8], [1, 1.6], [4, 4.6]]);
});

test('unspaced words (OpenAI style) are joined with single spaces', () => {
  assert.deepEqual(transcriptLines({ words: [w('hello', 0, 0.3), w('world', 0.35, 0.7)] }),
    [{ start: 0, end: 0.7, text: 'hello world' }]);
});

test('with no usable timings the whole text is one line ending at the last word', () => {
  assert.deepEqual(transcriptLines({ text: ' just text ', words: [] }), [{ start: 0, end: 0, text: 'just text' }]);
  assert.deepEqual(transcriptLines({ text: 'hi there', words: [{ start: 0, end: 2 }] }), [{ start: 0, end: 2, text: 'hi there' }]);
  assert.deepEqual(transcriptLines({ text: '  ', words: [] }), []);
});

test('transcribeTracks places every line on the meeting timeline', async () => {
  const track = { userId: 'u1', displayName: 'Ann', startMs: 1_000_000, pcmPath: '/x/u1_1000000.pcm' };
  const deps = { convert: async (_p, wav) => wav, cleanup: () => {}, stt: async () => ({ text: 'Hi. Bye.', segments: [
    { start: 0.5, end: 1, text: 'Hi.' }, { start: 2, end: 2.75, text: 'Bye.' }] }) };
  const { utterances } = await transcribeTracks([track], {}, deps);
  assert.deepEqual(utterances.map(({ userId, displayName, startMs, endMs, text }) => ({ userId, displayName, startMs, endMs, text })), [
    { userId: 'u1', displayName: 'Ann', startMs: 1_000_500, endMs: 1_001_000, text: 'Hi.' },
    { userId: 'u1', displayName: 'Ann', startMs: 1_002_000, endMs: 1_002_750, text: 'Bye.' }]);
});
