// Retrying a failed import: there is no PCM to re-transcribe, and the
// imported recording must survive a re-summarize.
import { config } from '../src/config/env.js';
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { retryMeeting, retryPlan, retryEligible } from '../src/pipeline/retry.js';

function failedImport({ withTranscript }) {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-retry-'));
  const db = openDb(':memory:');
  // The fake summarizer needs no network; keepAudio stays off (the default).
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', 'fake')`).run();
  const id = db.createImportedMeeting({ guildId: 'g1', title: 'Board call', startedAt: '2026-11-20T10:00:00.000Z' });
  if (withTranscript) {
    const audioDir = join(dir, 'audio', String(id));
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, 'mixed.mp3'), 'mp3');
    db.setAudioRetained(id, true);
    db.addAttendee(id, `import-${id}-1`, 'Speaker 1');
    db.replaceUtterances(id, [{ userId: `import-${id}-1`, displayName: 'Speaker 1', startMs: 1, endMs: 2, text: 'hello' }],
      { complete: true });
  }
  db.setMeetingStatus(id, withTranscript ? 'summary_failed' : 'transcription_failed');
  db.setImportError(id, 'earlier failure');
  return { dir, db, id, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a failed import without a transcript asks to be re-imported', () => {
  const { dir, db, id, cleanup } = failedImport({ withTranscript: false });
  try {
    const plan = retryPlan(db, id, { dataDir: dir });
    assert.deepEqual([plan.ok, plan.action, plan.reason], [false, 'none', 'Re-import the recording to retry transcription.']);
    assert.equal(retryEligible(db.getMeeting(id), plan), false);
  } finally { cleanup(); }
});

test('re-summarizing a failed import keeps its recording, clears the error and does not post', async () => {
  const { dir, db, id, cleanup } = failedImport({ withTranscript: true });
  try {
    assert.equal(retryPlan(db, id, { dataDir: dir }).action, 'resummarize');
    let posted = 0;
    const result = await retryMeeting(db, id, { dataDir: dir, deliver: async () => { posted++; } });
    assert.equal(result.ok, true);
    const meeting = db.getMeeting(id);
    assert.deepEqual([meeting.status, meeting.audio_retained, meeting.import_error], ['done', 1, null]);
    assert.ok(existsSync(join(dir, 'audio', String(id), 'mixed.mp3')));
    assert.equal(posted, 0, 'imports are posted only when asked at upload or via Post to Discord');
  } finally { cleanup(); }
});
