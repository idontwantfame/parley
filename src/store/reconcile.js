// src/store/reconcile.js
// Boot-time housekeeping that must run whether or not the Discord bot starts
// (web-only mode still needs it). Two jobs:
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
import { join } from 'node:path';

// Statuses whose meeting still needs its audio (a retry may retranscribe from PCM).
const KEEP_AUDIO_STATUSES = new Set(['recording', 'processing', 'transcription_failed', 'summary_failed']);

export async function reconcileOnBoot(db, audioRoot, { readdir = readdirSync, remove = rm, log = console, retentionDays = 30 } = {}) {
  let orphanMeetings = 0;

  // 1) Orphaned meetings from a crash mid-pipeline.
  for (const m of db.findOrphanedMeetings()) {
    db.setMeetingStatus(m.id, 'transcription_failed');
    orphanMeetings += 1;
    log.warn?.(`[reconcile] meeting ${m.id} was mid-pipeline at last shutdown → transcription_failed (retry from the dashboard).`);
  }

  const sweptDirs = await sweepAudio(db, audioRoot, { readdir, remove, log, retentionDays });
  return { orphanMeetings, sweptDirs };
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
    if (meeting?.status === 'done' && meeting.audio_retained
      && (retentionDays === 0 || !(Date.parse(meeting.ended_at) <= cutoff))) continue;
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
