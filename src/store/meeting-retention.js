import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/env.js';
import { meetingExportBasename } from '../delivery/meeting-export.js';
import { meetingProgress } from '../pipeline/progress.js';

/**
 * Remove a meeting's files: its audio folder and its automatic Markdown/JSON
 * exports (which hold the full transcript). Shared by delete, merge (for the
 * absorbed sources) and retention. Never throws; resolves to the number of
 * paths that could not be removed (each failure is logged).
 */
export async function removeMeetingArtifacts(meeting, {
  dataDir = config.dataDir, exportDir = config.exportDir, log = console,
} = {}) {
  const archive = meetingExportBasename(meeting);
  const results = await Promise.allSettled([
    rm(join(dataDir, 'audio', String(meeting.id)), { recursive: true, force: true }),
    rm(join(exportDir, `${archive}.md`), { force: true }),
    rm(join(exportDir, `${archive}.json`), { force: true }),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  for (const { reason } of failures) {
    log.warn(`[retention] File cleanup for meeting ${meeting.id} failed:`, reason?.message ?? reason);
  }
  return failures.length;
}

// Delete finished meetings (completed, failed or empty) outside campaigns that
// ended more than `days` ago, with their files. In-progress ones are skipped.
export async function pruneMeetings(db, days, {
  dryRun = true, dataDir = config.dataDir, exportDir = config.exportDir, now = Date.now(),
} = {}) {
  const cutoff = new Date(now - days * 86_400_000);
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(cutoff.getTime())) {
    throw new RangeError('Retention days must be a positive whole number.');
  }
  const eligible = db.expiredMeetings(cutoff.toISOString()).filter(({ id }) => !meetingProgress(id));
  if (dryRun) return { eligible: eligible.length, deleted: 0 };
  for (const meeting of eligible) db.deleteMeeting(meeting.id);
  const failures = await Promise.all(eligible.map((meeting) => removeMeetingArtifacts(meeting, { dataDir, exportDir })));
  const cleanupErrors = failures.reduce((sum, n) => sum + n, 0);
  return { eligible: eligible.length, deleted: eligible.length, cleanupErrors };
}
