// Boot reconcile for imports: uploads interrupted by a crash are deleted, and
// an import left mid-pipeline becomes a failed meeting with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { reconcileOnBoot, IMPORT_INTERRUPTED } from '../src/store/reconcile.js';

const quiet = { warn: () => {}, log: () => {} };

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-reconcile-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('reconcileOnBoot deletes stale uploads beside the audio folder', async () => {
  const { dir, cleanup } = tmp();
  try {
    const imports = join(dir, 'imports');
    mkdirSync(imports);
    writeFileSync(join(imports, 'a.m4a'), 'partial');
    writeFileSync(join(imports, 'b.bin'), 'partial');
    const result = await reconcileOnBoot(openDb(':memory:'), join(dir, 'audio'), { log: quiet });
    assert.equal(result.sweptUploads, 2);
    assert.deepEqual(readdirSync(imports), []);
  } finally { cleanup(); }
});

test('reconcileOnBoot copes with no uploads folder', async () => {
  const { dir, cleanup } = tmp();
  try {
    const result = await reconcileOnBoot(openDb(':memory:'), join(dir, 'audio'), { log: quiet, importsRoot: join(dir, 'none') });
    assert.equal(result.sweptUploads, 0);
  } finally { cleanup(); }
});

test('an import interrupted mid-pipeline fails with a reason and loses its partial audio', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const id = db.createImportedMeeting({ guildId: 'g', title: 'Clip', startedAt: '2026-11-20T10:00:00.000Z' });
    db.setAudioRetained(id, true);
    const audioDir = join(dir, 'audio', String(id));
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, 'mixed.mp3'), 'mp3');
    const discord = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    mkdirSync(join(dir, 'audio', String(discord)));
    writeFileSync(join(dir, 'audio', String(discord), 'u_1.pcm'), 'pcm');

    const result = await reconcileOnBoot(db, join(dir, 'audio'), { log: quiet });
    assert.equal(result.orphanMeetings, 2);
    const meeting = db.getMeeting(id);
    assert.deepEqual([meeting.status, meeting.import_error, meeting.audio_retained],
      ['transcription_failed', IMPORT_INTERRUPTED, 0]);
    assert.equal(existsSync(audioDir), false);
    assert.equal(db.getMeeting(discord).import_error, null);
    assert.ok(existsSync(join(dir, 'audio', String(discord), 'u_1.pcm')), 'a recorded meeting keeps its PCM for retry');
  } finally { cleanup(); }
});
