// Sentence-level transcript lines from a diarized (speaker-labelled) STT result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diarizedLines } from '../src/pipeline/transcribe.js';

const w = (word, start, end, speaker) => ({ word, start, end, speaker });

test('words split into lines at every speaker change, then at sentence ends', () => {
  const lines = diarizedLines({ words: [
    w(' Hello', 0, 0.3, 'SPEAKER_00'), w(' there.', 0.3, 0.6, 'SPEAKER_00'), w(' How', 0.7, 0.9, 'SPEAKER_00'),
    w(' are', 0.9, 1.0, 'SPEAKER_00'), w(' you', 1.0, 1.2, 'SPEAKER_01'), w(' doing?', 1.2, 1.5, 'SPEAKER_01'),
    w(' Fine.', 1.6, 1.9, 'SPEAKER_00')] });
  assert.deepEqual(lines, [
    { start: 0, end: 0.6, text: 'Hello there.', speaker: 'SPEAKER_00' },
    { start: 0.7, end: 1.0, text: 'How are', speaker: 'SPEAKER_00' },
    { start: 1.0, end: 1.5, text: 'you doing?', speaker: 'SPEAKER_01' },
    { start: 1.6, end: 1.9, text: 'Fine.', speaker: 'SPEAKER_00' },
  ]);
});

test('a long pause inside one speaker run starts a new line', () => {
  const lines = diarizedLines({ words: [w(' one', 0, 0.2, 'A'), w(' two', 5, 5.2, 'A')] });
  assert.deepEqual(lines.map((l) => l.text), ['one', 'two']);
});

test('a word without a speaker takes the speaker of the segment it falls in', () => {
  const lines = diarizedLines({
    words: [w(' Hi', 0, 0.2, null), w(' all.', 0.2, 0.4), w(' Yes.', 2, 2.3, null)],
    segments: [{ start: 0, end: 0.5, text: 'Hi all.', speaker: 'SPEAKER_01' },
      { start: 1.9, end: 2.4, text: 'Yes.', speaker: 'SPEAKER_00' }],
  });
  assert.deepEqual(lines.map(({ text, speaker }) => ({ text, speaker })), [
    { text: 'Hi all.', speaker: 'SPEAKER_01' }, { text: 'Yes.', speaker: 'SPEAKER_00' }]);
});

test('a word outside every labelled segment stays unattributed', () => {
  const lines = diarizedLines({ words: [w(' Hm.', 10, 10.2)],
    segments: [{ start: 0, end: 1, text: 'x', speaker: 'SPEAKER_00' }] });
  assert.deepEqual(lines, [{ start: 10, end: 10.2, text: 'Hm.', speaker: null }]);
});

test('without word timings, each segment is a line with its own speaker', () => {
  const lines = diarizedLines({ text: 'A. B.', words: [], segments: [
    { start: 3, end: 4, text: ' B. ', speaker: 'SPEAKER_01' }, { start: 0, end: 1, text: 'A.', speaker: 'SPEAKER_00' },
    { start: 5, end: 6, text: '  ', speaker: 'SPEAKER_00' }, { start: 7, end: 8, text: 'C.' }] });
  assert.deepEqual(lines, [
    { start: 0, end: 1, text: 'A.', speaker: 'SPEAKER_00' },
    { start: 3, end: 4, text: 'B.', speaker: 'SPEAKER_01' },
    { start: 7, end: 8, text: 'C.', speaker: null },
  ]);
});

test('with neither words nor segments the whole text is one unattributed line', () => {
  assert.deepEqual(diarizedLines({ text: ' just text ' }), [{ start: 0, end: 0, text: 'just text', speaker: null }]);
  assert.deepEqual(diarizedLines({ text: '' }), []);
  assert.deepEqual(diarizedLines(), []);
});

test('words arriving out of order are placed by time', () => {
  const lines = diarizedLines({ words: [w(' second.', 2, 2.5, 'B'), w(' First.', 0, 0.5, 'A')] });
  assert.deepEqual(lines.map((l) => l.text), ['First.', 'second.']);
});

test('a word WhisperX left unassigned joins the speaker around it instead of becoming its own line', () => {
  // whisperx.assign_word_speakers leaves words outside every speaker turn as
  // null; a stray one mid-sentence must not split off an "Unknown speaker" line.
  const w = (word, start, end, speaker) => ({ word, start, end, speaker });
  const lines = diarizedLines({ words: [
    w(' So', 0, 0.2, 'SPEAKER_00'), w(' the', 0.2, 0.3, null), w(' plan', 0.3, 0.6, 'SPEAKER_00'), w(' works.', 0.6, 1, 'SPEAKER_00'),
    w(' Agreed.', 1.4, 1.9, 'SPEAKER_01'),
  ], segments: [] });
  assert.deepEqual(lines.map((l) => [l.speaker, l.text]), [['SPEAKER_00', 'So the plan works.'], ['SPEAKER_01', 'Agreed.']]);
});

test('a file where no word has a speaker stays unknown rather than guessing', () => {
  const lines = diarizedLines({ words: [{ word: ' Hello.', start: 0, end: 0.5, speaker: null }], segments: [] });
  assert.deepEqual(lines.map((l) => l.speaker), [null]);
});
