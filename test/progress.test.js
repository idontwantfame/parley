import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingProgress, withMeetingProgress } from '../src/pipeline/progress.js';
import { transcribeTracks } from '../src/pipeline/transcribe.js';

test('audio progress accounts for failed and silent tracks and clears after completion', async () => {
  const id = 45;
  const tracks = ['failed.pcm', 'silent.pcm'].map((pcmPath) => ({ pcmPath, startMs: 0 }));
  await withMeetingProgress(id, tracks.length, async (progress) => {
    await transcribeTracks(tracks, {}, {
      convert: async () => {},
      cleanup: async () => {},
      stt: async (file) => {
        if (file === 'failed.wav') throw new Error('Synthetic decode failure');
        return { text: '', words: [] };
      },
      onTrackDone: ({ failed }) => {
        progress.completed++;
        if (failed) progress.failed++;
      },
    });
    assert.deepEqual(meetingProgress(id), {
      stage: 'transcribing', total: 2, completed: 2, failed: 1, etaSeconds: null,
    });
  });
  assert.equal(meetingProgress(id), null);
});
