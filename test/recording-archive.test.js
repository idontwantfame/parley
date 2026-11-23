import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveRecording, MP3_NAME } from '../src/voice/recording-archive.js';

test('archive only removes original tracks after a successful full transcription and encode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-mp3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pcm = 'speaker_1000.pcm';
  await writeFile(join(dir, pcm), Buffer.alloc(3200));
  await assert.rejects(() => archiveRecording(dir, { transcriptionComplete: true, run: async () => {
    throw new Error('Encoder failed');
  } }), /Encoder failed/);
  assert.ok((await readdir(dir)).includes(pcm));
  const mp3 = await archiveRecording(dir, { transcriptionComplete: false, run: async (cmd, args) => {
    assert.equal(cmd, 'ffmpeg');
    assert.ok(args.includes('libmp3lame'));
    await writeFile(args.at(-1), 'mock encoded audio');
  } });
  assert.equal(mp3, join(dir, MP3_NAME));
  assert.ok((await readdir(dir)).includes(pcm));
  await archiveRecording(dir, { transcriptionComplete: true, run: () => assert.fail('Should reuse the saved MP3') });
  assert.deepEqual(await readdir(dir), [MP3_NAME]);
  assert.ok((await readFile(mp3)).length);
});

import { canDiscardAudio } from '../src/voice/recording-archive.js';

// keepAudio=false deletes the meeting's audio dir after finalize — but only a
// fully transcribed meeting may lose it: a retry re-transcribes failed speakers
// from their PCM.
test('audio is discarded only after a complete transcript that was not archived', () => {
  assert.equal(canDiscardAudio({ audioRetained: false }, { transcription_complete: 1 }), true);
  assert.equal(canDiscardAudio({ audioRetained: false, empty: true }, { transcription_complete: 1 }), true);
});

test('a partial transcript keeps the audio for a retry', () => {
  assert.equal(canDiscardAudio({ audioRetained: false }, { transcription_complete: 0 }), false);
});

test('archived (kept) audio and unknown outcomes are never discarded', () => {
  assert.equal(canDiscardAudio({ audioRetained: true }, { transcription_complete: 1 }), false);
  assert.equal(canDiscardAudio(null, { transcription_complete: 1 }), false);
  assert.equal(canDiscardAudio({ audioRetained: false }, null), false);
  assert.equal(canDiscardAudio({ audioRetained: false }, { transcription_complete: null }), false);
});
