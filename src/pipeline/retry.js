// src/pipeline/retry.js
// Re-run a failed meeting from the dashboard or CLI. Chooses the right recovery
// path from the meeting's current state:
//
//   • Has stored utterances  → re-summarize only (skips STT entirely). Handles
//     summary_failed and any case where the transcript survived.
//   • No utterances + PCM on disk → re-run the full pipeline (transcribe +
//     summarize). Handles transcription_failed when the audio is still present.
//   • No utterances + no PCM  → unrecoverable; report clearly.
//
// Returns { ok, action, status, reason }.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { getGuildConfig } from '../store/config.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { buildTranscript, computeTalkTime } from './summarize.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { parsePcmName } from '../voice/audio.js';
import { processMeeting } from './orchestrator.js';
import { autoExportMeeting } from '../delivery/meeting-export.js';
import { campaignContextFor, foldMeetingIntoJournal } from '../campaign/journal.js';
import { withMeetingProgress } from './progress.js';
import { deliverSavedNotes } from '../delivery/status.js';
import { canDiscardAudio, retainRecording } from '../voice/recording-archive.js';

// Statuses the UI should offer a retry for. Never 'recording': that would
// transcribe partial PCM while capture is still writing it, mark the meeting
// done and delete the live audio directory. 'processing' stays: boot reconcile
// only fixes rows stranded by a crash, and a row left 'processing' by an error
// that escaped the pipeline needs a way out. A pipeline that is really running
// holds the meeting's progress entry, so withMeetingProgress refuses a second
// run (and the API hides Retry while progress exists).
export const RETRYABLE_STATUSES = new Set(['transcription_failed', 'summary_failed', 'processing']);

// An imported recording has no per-speaker PCM to re-transcribe from.
export const REIMPORT_REASON = 'Re-import the recording to retry transcription.';
const isImport = (meeting) => meeting?.source === 'import';

/**
 * Whether to offer Retry for a meeting, given its retryPlan. Besides failed
 * meetings, a finished one whose transcript is known to be partial (some
 * tracks failed STT) can be re-transcribed while its PCM is still on disk.
 */
export function retryEligible(meeting, plan) {
  if (!meeting || !plan?.ok) return false;
  if (RETRYABLE_STATUSES.has(meeting.status)) return true;
  return meeting.status === 'done' && meeting.transcription_complete === 0 && plan.action === 'retranscribe';
}


// Summarize a meeting's stored utterances with the guild's current summarizer
// config (provider, model, language, prompt). Throws on summarizer failure;
// writes nothing.
async function summarizeStored(db, meeting, cfg, onProgress) {
  const utterances = db.listUtterances(meeting.id).map((u) => ({
    userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
  }));
  const transcript = buildTranscript(utterances);
  const talktime = computeTalkTime(utterances);
  const meta = {
    channelName: meeting.channel_name, date: meeting.started_at,
    attendees: db.listAttendees(meeting.id).map((a) => a.display_name),
    summaryLanguage: resolveSummaryLanguage(cfg),
    summaryPrompt: cfg.summaryPrompt,
    campaignContext: campaignContextFor(db, meeting),
  };
  const summarizer = getSummarizer(cfg);
  const notes = await summarizer.summarize(transcript, meta, { onProgress });
  const modelUsed = summarizer.lastUsed ?? `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`;
  return { notes, talktime, meta, modelUsed };
}

/** Can this meeting's summary be regenerated from its stored transcript? */
export function regeneratePlan(db, meetingId) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, reason: 'Meeting not found.' };
  // Only finished meetings: failed ones go through retry (which may need to
  // re-transcribe), and recording/processing rows are still owned by the pipeline.
  if (meeting.status !== 'done') {
    return { ok: false, meeting, reason: meeting.status === 'recording' || meeting.status === 'processing'
      ? 'This meeting is still being recorded or processed.'
      : 'Only completed meetings can be regenerated — use Retry for failed ones.' };
  }
  if (!db.hasUtterances(meetingId)) {
    return { ok: false, meeting, reason: 'This meeting has no transcript to summarize.' };
  }
  return { ok: true, meeting };
}

/**
 * Regenerate a finished meeting's summary from its stored transcript using the
 * guild's current summarizer settings. Unlike a retry, a failure leaves the
 * existing summary and status untouched — the old notes stay until a new set
 * is actually in hand. Does not re-post to Discord.
 */
export function regenerateSummary(db, meetingId, { onProgress } = {}) {
  return withMeetingProgress(meetingId, null, () => regenerateSavedSummary(db, meetingId, onProgress));
}

async function regenerateSavedSummary(db, meetingId, onProgress) {
  const plan = regeneratePlan(db, meetingId);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const meeting = plan.meeting;
  const cfg = getGuildConfig(db, meeting.guild_id);
  let result;
  try {
    result = await summarizeStored(db, meeting, cfg, onProgress);
  } catch (err) {
    return { ok: false, reason: err.userMessage ?? describeSummarizerError(err, cfg.summarizerProvider) };
  }
  const { notes, talktime, modelUsed } = result;
  if (!regeneratePlan(db, meetingId).ok) return { ok: false, reason: 'The meeting changed during regeneration.' };
  db.replaceSummary(meetingId, meeting.guild_id, notes, talktime, modelUsed, meeting.started_at);
  await autoExportMeeting(db, meetingId);
  return { ok: true, status: 'done', modelUsed };
}

// After a re-summarize: archive the audio when the guild keeps recordings,
// else let the caller drop it. Returns whether a recording is kept. An
// import's recording IS the meeting's audio and is always kept as it is.
async function settleRetriedAudio(db, meeting, cfg, audioDir, progress) {
  if (isImport(meeting)) return !!meeting.audio_retained;
  let hasAudio = false;
  if (cfg.keepAudio) {
    progress.stage = 'archiving';
    hasAudio = await retainRecording(audioDir, meeting.transcription_complete === 1, meeting.id);
  }
  db.setAudioRetained(meeting.id, hasAudio);
  return hasAudio;
}

/** Decide what a retry would do, without doing it (for enabling UI + messaging). */
export function retryPlan(db, meetingId, { dataDir, exists = readdirSync } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, action: 'none', reason: 'Meeting not found.' };
  const hasUtterances = db.hasUtterances(meetingId);
  let pcmCount = 0;
  try { pcmCount = exists(join(dataDir, 'audio', String(meetingId))).filter((f) => f.endsWith('.pcm')).length; }
  catch { pcmCount = 0; }
  if (pcmCount > 0 && meeting.transcription_complete !== 1) {
    return { ok: true, action: 'retranscribe', meeting };
  }
  if (hasUtterances) return { ok: true, action: 'resummarize', meeting };
  if (pcmCount > 0) return { ok: true, action: 'retranscribe', meeting };
  if (isImport(meeting)) return { ok: false, action: 'none', meeting, reason: REIMPORT_REASON };
  return { ok: false, action: 'none', meeting,
    reason: 'No transcript and no saved audio remain for this meeting, so it cannot be retried.' };
}

/**
 * Execute the retry. `deps.deliver` (optional) posts to Discord when a live
 * client is available; omit it for the dashboard (notes just show in the UI).
 */
export async function retryMeeting(db, meetingId, { dataDir, deliver = null } = {}) {
  const plan = retryPlan(db, meetingId, { dataDir });
  if (!plan.ok) return { ok: false, action: plan.action, status: db.getMeeting(meetingId)?.status, reason: plan.reason };

  const meeting = plan.meeting;
  const cfg = getGuildConfig(db, meeting.guild_id);

  if (plan.action === 'resummarize') return withMeetingProgress(meetingId, null, async (progress) => {
    db.setMeetingStatus(meetingId, 'processing');
    if (isImport(meeting)) db.setImportError(meetingId, null);
    let result;
    try {
      result = await summarizeStored(db, meeting, cfg);
    } catch (err) {
      db.setMeetingStatus(meetingId, 'summary_failed');
      await autoExportMeeting(db, meetingId);
      return { ok: false, action: 'resummarize', status: 'summary_failed',
        reason: err.userMessage ?? describeSummarizerError(err, cfg.summarizerProvider) };
    }
    const { notes, talktime, meta, modelUsed } = result;
    db.replaceSummary(meetingId, meeting.guild_id, notes, talktime, modelUsed, meeting.started_at);
    const audioDir = join(dataDir, 'audio', String(meetingId));
    const hasAudio = await settleRetriedAudio(db, meeting, cfg, audioDir, progress);
    db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
    if (!hasAudio) await rm(audioDir, { recursive: true, force: true }).catch(() => {});
    const exportResult = await autoExportMeeting(db, meetingId);
    // An import is posted only when asked at upload (or via Post to Discord).
    if (deliver && !isImport(meeting)) {
      await deliverSavedNotes(db, meetingId, (savedNotes, savedTalktime) => deliver(savedNotes, savedTalktime, meta));
    }
    // A session that failed earlier never reached its campaign journal.
    if (meeting.campaign_id) progress.stage = 'journal';
    await foldMeetingIntoJournal(db, meetingId, { cfg })
      .catch((err) => console.error(`[retry] meeting ${meetingId}: campaign journal update failed: ${err.message}`));
    return { ok: true, action: 'resummarize', status: 'done', ...exportResult };
  });

  // retranscribe: rebuild tracks from the PCM filenames and run the full pipeline.
  const audioDir = join(dataDir, 'audio', String(meetingId));
  const nameById = new Map(db.listAttendees(meetingId).map((a) => [a.user_id, a.display_name]));
  const tracks = readdirSync(audioDir)
    .filter((f) => f.endsWith('.pcm'))
    .map((f) => {
      const { userId, startMs } = parsePcmName(f);
      return { userId, displayName: nameById.get(userId) || userId, startMs, pcmPath: join(audioDir, f) };
    })
    .sort((a, b) => a.startMs - b.startMs);
  try {
    const { notes, empty, exported, exports, exportError, audioRetained, reviewPending } =
      await processMeeting(db, meetingId, { tracks, cfg, deliver });
    // Success (or a confirmed-empty meeting): the PCM has served its purpose, so
    // drop the audio dir — like the bot's finalize, only once the transcript is
    // complete; a still-partial one keeps it for another retry.
    if (canDiscardAudio({ audioRetained, reviewPending }, db.getMeeting(meetingId))) {
      await rm(audioDir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true, action: 'retranscribe', status: db.getMeeting(meetingId)?.status,
      empty: !reviewPending && (!notes || !!empty), exported, exports, exportError };
  } catch (err) {
    // Keep the PCM on failure so a later retry can try again.
    const status = db.getMeeting(meetingId).status;
    return { ok: false, action: 'retranscribe', status,
      reason: err.userMessage || describeSummarizerError(err, cfg.summarizerProvider) };
  }
}
