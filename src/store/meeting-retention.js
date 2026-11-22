import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/env.js';
import { meetingExportBasename } from '../delivery/meeting-export.js';
import { meetingProgress } from '../pipeline/progress.js';

export async function pruneMeetings(db, days, {
  dryRun = true, dataDir = config.dataDir, exportDir = config.exportDir, now = Date.now(),
} = {}) {
  const cutoff = new Date(now - days * 86_400_000);
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(cutoff.getTime())) {
    throw new RangeError('Retention days must be a positive whole number.');
  }
  const eligible = db.expiredMeetings(cutoff.toISOString()).filter(({ id }) => !meetingProgress(id));
  if (dryRun) return { eligible: eligible.length, deleted: 0 };
  const cleanup = [];
  for (const meeting of eligible) {
    db.deleteMeeting(meeting.id);
    const archive = meetingExportBasename(meeting);
    cleanup.push(
      rm(join(dataDir, 'audio', String(meeting.id)), { recursive: true, force: true }),
      rm(join(exportDir, `${archive}.md`), { force: true }),
      rm(join(exportDir, `${archive}.json`), { force: true }),
    );
  }
  let cleanupErrors = 0;
  for (const result of await Promise.allSettled(cleanup)) {
    if (result.status === 'rejected') {
      cleanupErrors++;
      console.warn('[retention] File cleanup failed:', result.reason.message);
    }
  }
  return { eligible: eligible.length, deleted: eligible.length, cleanupErrors };
}
