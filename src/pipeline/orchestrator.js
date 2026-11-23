import { sharedSpeakerPrefix, transcribeTracks } from './transcribe.js';
import { STT_PROVIDER_LABELS } from '../adapters/stt/index.js';
import { buildTranscript, computeTalkTime } from './summarize.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { autoExportMeeting } from '../delivery/meeting-export.js';
import { getVocabulary } from '../store/vocabulary.js';
import { campaignContextFor, foldMeetingIntoJournal } from '../campaign/journal.js';
import { withMeetingProgress } from './progress.js';
import { deliverSavedNotes } from '../delivery/status.js';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { retainRecording } from '../voice/recording-archive.js';

// Provider-neutral: the STT provider may be the local sidecar or a cloud API.
function withTranscriptionMessage(err, cfg) {
  const provider = STT_PROVIDER_LABELS[cfg?.sttProvider || 'sidecar'] || 'the speech-to-text provider';
  err.userMessage = `Transcription failed — check that ${provider} is reachable and configured. (${err.message})`;
  return err;
}

function failTranscription(db, meetingId, err, cfg) {
  db.setTranscriptionComplete(meetingId, false);
  db.setMeetingStatus(meetingId, 'transcription_failed');
  return withTranscriptionMessage(err, cfg);
}

// Transcribe every track and persist the utterances. Throws (with a
// userMessage) when nothing usable came back or the transcript can't be saved.
async function transcribeAndStore(db, meetingId, opts, transcribe) {
  let result;
  try {
    result = await transcribe(opts.tracks, { ...opts.cfg, transcriptionVocabulary: getVocabulary(db) });
  } catch (err) {
    throw failTranscription(db, meetingId, err, opts.cfg);
  }
  // transcribeTracks returns { utterances, failures }, but opts.transcribe is an
  // injectable seam other callers/tests still use to return a bare array.
  const { utterances, failures = [] } = Array.isArray(result) ? { utterances: result } : result;

  // A2: one or more tracks failing STT must not sink a meeting that otherwise
  // has usable transcript — only bail out when every track failed.
  if (failures.length > 0) {
    console.warn(`[orchestrator] ${failures.length} track(s) failed transcription for meeting ${meetingId}`);
  }
  const sharedMicFailure = failures.find(({ userId }) => opts.cfg.sharedMicUserIds?.includes(userId));
  if (sharedMicFailure) {
    const { displayName, error } = sharedMicFailure;
    const err = failTranscription(db, meetingId,
      new Error(`Could not separate voices on ${displayName}'s shared mic: ${error}`), { sttProvider: 'sidecar' });
    err.userMessage = `Could not separate the voices on ${displayName}'s shared microphone (${error}). `
      + 'Enable speaker detection on the transcription sidecar, or turn off Shared microphone for this speaker in Settings, then retry.';
    throw err;
  }
  if (utterances.length === 0 && failures.length > 0) {
    const err = new Error(`All ${failures.length} track(s) failed transcription. First error: ${failures[0].error}`);
    throw failTranscription(db, meetingId, err, opts.cfg);
  }
  const prefix = sharedSpeakerPrefix(meetingId);
  const sharedSpeakers = new Map();
  for (const { userId, displayName } of utterances) {
    if (userId.startsWith(prefix)) sharedSpeakers.set(userId, displayName);
  }
  try {
    db.replaceUtterances(meetingId, utterances, { complete: failures.length === 0, sharedSpeakers });
  } catch (err) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    err.userMessage = `Transcription could not be saved safely. (${err.message})`;
    throw err;
  }
  return { utterances, failures, needsSpeakerReview: sharedSpeakers.size > 0 };
}

export function processMeeting(db, meetingId, opts) {
  return withMeetingProgress(meetingId, opts.tracks.length, (progress) => runMeeting(db, meetingId, opts, progress));
}

async function runMeeting(db, meetingId, opts, progress) {
  const transcribe = opts.transcribe || ((tracks, cfg) => transcribeTracks(tracks, cfg, {
    meetingId,
    onTrackDone: ({ failed, count }) => {
      progress.completed += count;
      if (failed) progress.failed += count;
    },
  }));
  db.setMeetingStatus(meetingId, 'processing');

  const transcribeStart = Date.now();
  const { utterances, failures, needsSpeakerReview } = await transcribeAndStore(db, meetingId, opts, transcribe);
  const transcribeMs = Date.now() - transcribeStart;

  // Nobody actually spoke (bot joined an empty/near-silent channel). Don't
  // summarize or deliver — signal the caller to discard the meeting so these
  // empties never clutter the archive.
  if (utterances.length === 0) {
    db.setMeetingStatus(meetingId, 'empty');
    return { notes: null, talktime: [], empty: true };
  }
  if (needsSpeakerReview) {
    return { reviewPending: true };
  }

  return finishMeeting(db, meetingId, {
    cfg: opts.cfg, summarizer: opts.summarizer || getSummarizer(opts.cfg), deliver: opts.deliver, progress,
    timings: { transcribeMs, tracks: opts.tracks.length },
    retainAudio: async () => {
      if (!opts.cfg.keepAudio || opts.tracks.length === 0) return false;
      progress.stage = 'archiving';
      return retainRecording(dirname(opts.tracks[0].pcmPath), failures.length === 0, meetingId);
    },
  });
}

export function finishReviewedMeeting(db, meetingId, { cfg, audioDir, deliver }) {
  return withMeetingProgress(meetingId, null, async (progress) => {
    try {
      const complete = db.getMeeting(meetingId).transcription_complete === 1;
      const result = await finishMeeting(db, meetingId, {
        cfg, summarizer: getSummarizer(cfg), deliver, progress,
        retainAudio: async () => {
          if (!cfg.keepAudio) return false;
          progress.stage = 'archiving';
          return retainRecording(audioDir, complete, meetingId);
        },
      });
      if (complete && !result.audioRetained) {
        await rm(audioDir, { recursive: true, force: true }).catch((error) => {
          console.warn(`[audio] meeting ${meetingId}: could not remove temporary audio: ${error.message}`);
        });
      }
      return result;
    } catch (error) {
      if (db.getMeeting(meetingId)?.status === 'processing') db.setMeetingStatus(meetingId, 'summary_failed');
      throw error;
    }
  });
}

// What the summarizer is given: the merged transcript plus meeting context.
function summaryInput(db, meeting, cfg) {
  const speakers = db.listUtterances(meeting.id).map((u) => ({
    userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
  }));
  const meta = {
    channelName: meeting.channel_name,
    date: meeting.started_at,
    attendees: db.listAttendees(meeting.id).map((a) => a.display_name),
    summaryLanguage: resolveSummaryLanguage(cfg),
    summaryPrompt: cfg.summaryPrompt,
    campaignContext: campaignContextFor(db, meeting),
  };
  return { transcript: buildTranscript(speakers), talktime: computeTalkTime(speakers), meta };
}

async function summarizeOrFail(db, meetingId, summarizer, { transcript, meta }, cfg) {
  try {
    return await summarizer.summarize(transcript, meta);
  } catch (err) {
    db.setMeetingStatus(meetingId, 'summary_failed');
    // A failed summary must not stop the transcript archive.
    await autoExportMeeting(db, meetingId);
    // FallbackSummarizer already composed a message naming both attempts; don't
    // overwrite it with one that only mentions the primary provider.
    err.userMessage ??= describeSummarizerError(err, cfg.summarizerProvider);
    throw err;
  }
}

// Campaign sessions also update the campaign journal. Best-effort and last:
// the notes are already saved and delivered, and a journal failure can be
// retried from the Campaigns page ("Update journal").
async function foldIntoCampaign(db, meeting, { cfg, summarizer, progress }) {
  if (!meeting.campaign_id) return null;
  progress.stage = 'journal';
  try {
    return await foldMeetingIntoJournal(db, meeting.id, { cfg, summarizer });
  } catch (err) {
    console.error(`[pipeline] meeting ${meeting.id}: campaign journal update failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Summarize a meeting whose transcript is already stored, then save the notes
 * and todos, settle its audio (`retainAudio` resolves to whether a recording
 * is kept), mark it done, export, deliver (when `deliver` is given) and fold
 * it into its campaign journal. Shared by recorded and imported meetings.
 * Throws with a userMessage (status summary_failed) when summarizing fails.
 */
export async function finishMeeting(db, meetingId, { cfg, summarizer, deliver = null, progress, timings = {}, retainAudio }) {
  const meeting = db.getMeeting(meetingId);
  const input = summaryInput(db, meeting, cfg);
  progress.stage = 'summarizing';
  const summarizeStart = Date.now();
  const notes = await summarizeOrFail(db, meetingId, summarizer, input, cfg);
  const summarizeMs = Date.now() - summarizeStart;
  const { transcribeMs, ...rest } = timings;
  const transcriptionLog = transcribeMs == null ? '' : `transcribe ${transcribeMs}ms (${rest.tracks} tracks), `;
  console.log(`[pipeline] meeting ${meetingId}: ${transcriptionLog}summarize ${summarizeMs}ms`);

  // summarizer.lastUsed is set by FallbackSummarizer to whichever provider
  // actually produced these notes; plain adapters leave it undefined.
  const modelUsed = summarizer.lastUsed ?? `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`;
  // Swap summary + todos in one transaction (like retry/regenerate): a re-run
  // after a crash must drop stale todos and keep the ones already ticked off.
  // Todos are dated from the MEETING, not now(): a pipeline that runs long
  // would otherwise stamp today onto a meeting that started hours ago, so the
  // action items collapse onto the wrong day in the timeline view.
  db.replaceSummary(meetingId, meeting.guild_id, notes, input.talktime, modelUsed, meeting.started_at,
    { transcribeMs, summarizeMs, ...rest });
  const audioRetained = await retainAudio();
  db.setAudioRetained(meetingId, audioRetained);
  db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
  const exportResult = await autoExportMeeting(db, meetingId);

  // Delivery is the last step and runs AFTER the summary is safely persisted, so
  // a posting failure (missing perms, deleted channel) must not throw away a
  // finished meeting or flip it back to a failed state — the notes already live
  // in the dashboard. Surface it via `delivered` + `deliveryError` so callers can
  // log it or offer a re-post, without treating the meeting as failed.
  const { delivered = false, deliveryError = null } = deliver
    ? await deliverSavedNotes(db, meetingId, (savedNotes, savedTalktime) => deliver(savedNotes, savedTalktime, input.meta))
    : {};
  const journal = await foldIntoCampaign(db, meeting, { cfg, summarizer, progress });
  return { notes, talktime: input.talktime, delivered, deliveryError, journal, audioRetained, ...exportResult };
}
