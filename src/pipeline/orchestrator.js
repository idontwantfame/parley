import { transcribeTracks } from './transcribe.js';
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
  if (utterances.length === 0 && failures.length > 0) {
    const err = new Error(`All ${failures.length} track(s) failed transcription. First error: ${failures[0].error}`);
    throw failTranscription(db, meetingId, err, opts.cfg);
  }
  try {
    db.replaceUtterances(meetingId, utterances, { complete: failures.length === 0 });
  } catch (err) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    err.userMessage = `Transcription could not be saved safely. (${err.message})`;
    throw err;
  }
  return { utterances, failures };
}

export function processMeeting(db, meetingId, opts) {
  return withMeetingProgress(meetingId, opts.tracks.length, (progress) => runMeeting(db, meetingId, opts, progress));
}

async function runMeeting(db, meetingId, opts, progress) {
  const meeting = db.getMeeting(meetingId);
  const transcribe = opts.transcribe || ((tracks, cfg) => transcribeTracks(tracks, cfg, {
    onTrackDone: ({ failed }) => {
      progress.completed++;
      if (failed) progress.failed++;
    },
  }));
  const summarizer = opts.summarizer || getSummarizer(opts.cfg);

  db.setMeetingStatus(meetingId, 'processing');

  const transcribeStart = Date.now();
  const { utterances, failures } = await transcribeAndStore(db, meetingId, opts, transcribe);
  const transcribeMs = Date.now() - transcribeStart;

  // Nobody actually spoke (bot joined an empty/near-silent channel). Don't
  // summarize or deliver — signal the caller to discard the meeting so these
  // empties never clutter the archive.
  if (utterances.length === 0) {
    db.setMeetingStatus(meetingId, 'empty');
    return { notes: null, talktime: [], empty: true };
  }

  const speakers = db.listUtterances(meetingId).map((u) => ({
    userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
  }));
  const transcript = buildTranscript(speakers);
  const talktime = computeTalkTime(speakers);
  const attendees = db.listAttendees(meetingId).map((a) => a.display_name);
  const meta = {
    channelName: meeting.channel_name,
    date: meeting.started_at,
    attendees,
    summaryLanguage: resolveSummaryLanguage(opts.cfg),
    summaryPrompt: opts.cfg.summaryPrompt,
    campaignContext: campaignContextFor(db, meeting),
  };

  let notes;
  progress.stage = 'summarizing';
  const summarizeStart = Date.now();
  try {
    notes = await summarizer.summarize(transcript, meta);
  } catch (err) {
    db.setMeetingStatus(meetingId, 'summary_failed');
    // A failed summary must not stop the transcript archive.
    await autoExportMeeting(db, meetingId);
    // FallbackSummarizer already composed a message naming both attempts; don't
    // overwrite it with one that only mentions the primary provider.
    err.userMessage ??= describeSummarizerError(err, opts.cfg.summarizerProvider);
    throw err;
  }
  const summarizeMs = Date.now() - summarizeStart;

  const timings = { transcribeMs, summarizeMs, tracks: opts.tracks.length };
  console.log(`[pipeline] meeting ${meetingId}: transcribe ${transcribeMs}ms (${opts.tracks.length} tracks), summarize ${summarizeMs}ms`);

  // summarizer.lastUsed is set by FallbackSummarizer to whichever provider
  // actually produced these notes; plain adapters leave it undefined.
  const modelUsed = summarizer.lastUsed ?? `${opts.cfg.summarizerProvider}:${opts.cfg.summarizerModel || ''}`;
  // Swap summary + todos in one transaction (like retry/regenerate): a re-run
  // after a crash must drop stale todos and keep the ones already ticked off.
  // Todos are dated from the MEETING, not now(): a pipeline that runs long
  // would otherwise stamp today onto a meeting that started hours ago, so the
  // action items collapse onto the wrong day in the timeline view.
  db.replaceSummary(meetingId, meeting.guild_id, notes, talktime, modelUsed, meeting.started_at, timings);
  let audioRetained = false;
  if (opts.cfg.keepAudio && opts.tracks.length > 0) {
    progress.stage = 'archiving';
    audioRetained = await retainRecording(dirname(opts.tracks[0].pcmPath), failures.length === 0, meetingId);
  }
  db.setAudioRetained(meetingId, audioRetained);
  db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
  const exportResult = await autoExportMeeting(db, meetingId);

  // Delivery is the last step and runs AFTER the summary is safely persisted, so
  // a posting failure (missing perms, deleted channel) must not throw away a
  // finished meeting or flip it back to a failed state — the notes already live
  // in the dashboard. Surface it via `delivered` + `deliveryError` so callers can
  // log it or offer a re-post, without treating the meeting as failed.
  const { delivered = false, deliveryError = null } = opts.deliver
    ? await deliverSavedNotes(db, meetingId, (savedNotes, savedTalktime) => opts.deliver(savedNotes, savedTalktime, meta))
    : {};

  // Campaign sessions also update the campaign journal. Best-effort and last:
  // the notes are already saved and delivered, and a journal failure can be
  // retried from the Campaigns page ("Update journal").
  let journal = null;
  if (meeting.campaign_id) {
    progress.stage = 'journal';
    try {
      journal = await foldMeetingIntoJournal(db, meetingId, { cfg: opts.cfg, summarizer });
    } catch (err) {
      journal = { error: err.message };
      console.error(`[pipeline] meeting ${meetingId}: campaign journal update failed: ${err.message}`);
    }
  }
  return { notes, talktime, delivered, deliveryError, journal, audioRetained, ...exportResult };
}
