// src/store/reconcile.js
// Boot-time housekeeping that must run whether or not the Discord bot starts
// (web-only mode still needs it). It also clears interrupted Discord deliveries
// and campaign-journal updates left 'updating' by a restart. Two main jobs:
//
//   1. Orphaned meetings — rows left in 'recording'/'processing' by a crash mid-
//      pipeline. Mark them 'transcription_failed' so the dashboard offers a retry
//      (the PCM is usually still on disk) instead of stranding them forever.
//   2. Orphaned audio dirs — data/audio/<id> directories whose meeting is gone
//      (deleted) or already 'done'/'empty' (audio no longer needed). These
//      accumulate unbounded otherwise.
//
// Pure-ish: fs access is injectable for tests.
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { IMPORT_UPLOADS_DIR } from '../config/env.js';

export const IMPORT_INTERRUPTED = 'Parley restarted while this recording was being imported.';

// An import cut off by a restart: say so, and drop its partial audio unless a
// transcript was already saved (then a retry can still re-summarize it).
async function reconcileImport(db, meeting, audioRoot, { remove, log }) {
  db.setImportError(meeting.id, IMPORT_INTERRUPTED);
  if (db.hasUtterances(meeting.id)) return;
  db.setAudioRetained(meeting.id, false);
  try {
    await remove(join(audioRoot, String(meeting.id)), { recursive: true, force: true });
  } catch (error) {
    log.warn?.(`[reconcile] could not remove audio for import ${meeting.id}: ${error.message}`);
  }
}

// Uploads still waiting at boot belong to requests that never finished.
async function sweepUploads(importsRoot, { readdir, remove, log }) {
  let names = [];
  try { names = readdir(importsRoot); } catch { return 0; } // no uploads folder yet
  let swept = 0;
  for (const name of names) {
    try {
      await remove(join(importsRoot, name), { recursive: true, force: true });
      swept += 1;
    } catch (error) {
      log.warn?.(`[reconcile] could not remove stale upload ${name}: ${error.message}`);
    }
  }
  if (swept > 0) log.log?.(`[reconcile] removed ${swept} interrupted upload(s).`);
  return swept;
}

// Statuses whose meeting still needs its audio (a retry may retranscribe from PCM).
const KEEP_AUDIO_STATUSES = new Set(['recording', 'processing', 'transcription_failed', 'summary_failed']);

export async function reconcileOnBoot(db, audioRoot, {
  readdir = readdirSync, remove = rm, log = console, retentionDays = 30,
  importsRoot = join(dirname(audioRoot), IMPORT_UPLOADS_DIR),
} = {}) {
  let orphanMeetings = 0;
  db.interruptDeliveries();
  // Journal updates run in-process, so none can still be running at boot.
  db.resetInterruptedJournals();

  // 1) Orphaned meetings from a crash mid-pipeline.
  for (const m of db.findOrphanedMeetings()) {
    db.setMeetingStatus(m.id, 'transcription_failed');
    if (m.source === 'import') await reconcileImport(db, m, audioRoot, { remove, log });
    orphanMeetings += 1;
    log.warn?.(`[reconcile] meeting ${m.id} was mid-pipeline at last shutdown → transcription_failed (retry from the dashboard).`);
  }

  const sweptDirs = await sweepAudio(db, audioRoot, { readdir, remove, log, retentionDays });
  const sweptUploads = await sweepUploads(importsRoot, { readdir, remove, log });
  return { orphanMeetings, sweptDirs, sweptUploads };
}

export async function sweepAudio(db, audioRoot, { readdir = readdirSync, remove = rm, log = console, retentionDays = 30 } = {}) {
  let sweptDirs = 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let dirs = [];
  try { dirs = readdir(audioRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { dirs = []; } // no audio root yet → nothing to sweep

  for (const name of dirs) {
    const id = Number(name);
    if (!Number.isInteger(id)) continue; // ignore non-numeric dirs we didn't create
    const meeting = db.getMeeting(id);
    // A finished meeting's audio still has a use while within the audio
    // retention window: a retained recording, or raw tracks that a retry can
    // re-transcribe because the transcript is known to be incomplete.
    const stillUseful = meeting?.status === 'done'
      && (meeting.audio_retained || meeting.transcription_complete === 0);
    if (stillUseful && (retentionDays === 0 || !(Date.parse(meeting.ended_at) <= cutoff))) continue;
    // Remove when the meeting is gone (deleted) or in a terminal state that no
    // longer needs the PCM. Keep dirs for meetings that might still be retried.
    if (!meeting || !KEEP_AUDIO_STATUSES.has(meeting.status)) {
      try {
        await remove(join(audioRoot, name), { recursive: true, force: true });
        if (meeting?.audio_retained) db.setAudioRetained(id, false);
        sweptDirs += 1;
      } catch (error) {
        log.warn?.(`[reconcile] could not remove audio for meeting ${id}: ${error.message}`);
      }
    }
  }
  if (sweptDirs > 0) log.log?.(`[reconcile] swept ${sweptDirs} audio dir(s).`);
  return sweptDirs;
}
