// src/pipeline/import.js
// Turn a recording made outside Discord (uploaded from the dashboard) into a
// meeting: ffmpeg converts it to the meeting's archived MP3 (so the player and
// seekable transcript work unchanged), the local sidecar transcribes it —
// optionally telling speakers apart — and the notes go through the same
// summarize/save/deliver path as a recorded meeting (finishMeeting).
//
// One file holds every speaker, so speakers are per-recording ids
// (import-<meetingId>-<n>, "Speaker n") that can be renamed afterwards.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/env.js';
import { createSidecarSTT } from '../adapters/stt/sidecar.js';
import { resolveSttModel } from '../adapters/stt/index.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { getGuildConfig } from '../store/config.js';
import { getVocabulary } from '../store/vocabulary.js';
import { MIX_ORIGIN_NAME } from '../voice/mix.js';
import { MP3_NAME } from '../voice/recording-archive.js';
import { FFMPEG_INPUT_GUARD, runFfmpeg } from '../voice/ffmpeg.js';
import { diarizedLines, transcriptLines, vocabularyHint } from './transcribe.js';
import { finishMeeting } from './orchestrator.js';
import { withMeetingProgress } from './progress.js';

// Progress stage while converting + transcribing (the dashboard shows
// "Transcribing and detecting speakers…").
export const IMPORT_STAGE = 'importing';
// Progress stage while waiting for an earlier import to finish transcribing
// (the dashboard shows "Waiting for another import to finish…").
export const QUEUED_STAGE = 'queued';
export const UNKNOWN_SPEAKER = 'Unknown speaker';
export const NO_SPEECH = 'No speech was detected in the recording.';

const SINGLE_SPEAKER = 'single';
const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;
const MP3_BITRATE = '64k';
const MP3_SAMPLE_RATE = '24000';

/** URL-safe per-recording speaker id (0 = unknown speaker). */
export const importSpeakerId = (meetingId, n) => `import-${meetingId}-${n}`;

/**
 * Give lines ({ speaker: label|null }) their speaker identity: labels become
 * "Speaker 1", "Speaker 2"… in order of first appearance; null → Unknown speaker.
 */
export function labelSpeakers(lines, meetingId) {
  const labels = [...new Set(lines.map((line) => line.speaker).filter((s) => s !== null))];
  const known = new Map(labels.map((label, i) => [label,
    { userId: importSpeakerId(meetingId, i + 1), displayName: `Speaker ${i + 1}` }]));
  const unknown = { userId: importSpeakerId(meetingId, 0), displayName: UNKNOWN_SPEAKER };
  return lines.map(({ speaker, ...line }) => ({ ...(speaker === null ? unknown : known.get(speaker)), ...line }));
}

/**
 * Utterances (epoch ms), attendees and the recording's last spoken moment from
 * a sidecar result. Without speaker detection every line is Speaker 1.
 */
export function importUtterances(result, { meetingId, originMs, speakers }) {
  const lines = speakers
    ? diarizedLines(result)
    : transcriptLines(result).map((line) => ({ ...line, speaker: SINGLE_SPEAKER }));
  const utterances = labelSpeakers(lines, meetingId).map(({ userId, displayName, start, end, text }) => ({
    userId, displayName, startMs: originMs + Math.round(start * 1000), endMs: originMs + Math.round(end * 1000), text,
  }));
  const attendees = [...new Map(utterances.map(({ userId, displayName }) => [userId, { userId, displayName }])).values()];
  const endMs = utterances.reduce((latest, u) => Math.max(latest, u.endMs), originMs);
  return { utterances, attendees, endMs: utterances.length ? endMs : null };
}

const withUserMessage = (err, userMessage) => Object.assign(err, { userMessage });

function ffmpegError(err) {
  if (err?.code === 'ENOENT') {
    return withUserMessage(err, 'ffmpeg is not installed, so the recording could not be converted. Install ffmpeg (the Docker image includes it) and import it again.');
  }
  if (err?.killed) {
    return withUserMessage(err, `Converting the recording took longer than ${FFMPEG_TIMEOUT_MS / 60_000} minutes and was stopped.`);
  }
  const detail = String(err?.stderr || err?.message || '').trim().split('\n').filter(Boolean).pop() || 'unknown error';
  return withUserMessage(err, `The file could not be read as audio or video. (${detail.slice(0, 300)})`);
}

// Convert the upload into the meeting's archived MP3 (mono speech quality) and
// record where it starts on the meeting timeline. Written under a temporary
// name so a failed conversion never leaves a half-written recording.
async function convertUpload(uploadPath, audioDir, originMs, runFfmpeg) {
  await mkdir(audioDir, { recursive: true, mode: 0o700 });
  const output = join(audioDir, MP3_NAME);
  const temporary = join(audioDir, `.${randomUUID()}.mp3`);
  try {
    await runFfmpeg('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...FFMPEG_INPUT_GUARD, '-i', uploadPath, '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', MP3_SAMPLE_RATE, '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-f', 'mp3', temporary],
    { timeout: FFMPEG_TIMEOUT_MS });
    if ((await stat(temporary)).size === 0) throw new Error('ffmpeg produced an empty recording.');
    await rename(temporary, output);
  } catch (err) {
    throw ffmpegError(err);
  } finally {
    await rm(temporary, { force: true });
  }
  await writeFile(join(audioDir, MIX_ORIGIN_NAME), JSON.stringify({ originMs }), { mode: 0o600 });
  return output;
}

function sttOptions(db, cfg, job) {
  const bounds = job.speakers ? { minSpeakers: job.minSpeakers, maxSpeakers: job.maxSpeakers } : {};
  // Imports always go to the local sidecar, whatever the guild's provider.
  return { model: resolveSttModel(cfg, 'sidecar'), language: cfg.language,
    vocabulary: vocabularyHint(getVocabulary(db)), diarize: !!job.speakers, ...bounds };
}

function storeTranscript(db, meetingId, { utterances, attendees, endMs }) {
  for (const { userId, displayName } of attendees) db.addAttendee(meetingId, userId, displayName);
  db.replaceUtterances(meetingId, utterances, { complete: true });
  db.setMeetingEndedAt(meetingId, new Date(endMs).toISOString());
}

// Convert + transcribe + store. On failure nothing usable is left: the meeting
// is transcription_failed and the converted audio is dropped (re-import to retry).
async function transcribeImport(db, meetingId, { job, cfg, originMs, deps }) {
  const audioDir = join(deps.dataDir, 'audio', String(meetingId));
  try {
    const mp3 = await convertUpload(job.uploadPath, audioDir, originMs, deps.runFfmpeg);
    // Free the disk early; runImport tries again (and logs) when it ends.
    await rm(job.uploadPath, { force: true }).catch(() => {});
    db.setAudioRetained(meetingId, true);
    const result = await deps.transcribe(mp3, sttOptions(db, cfg, job));
    const transcript = importUtterances(result, { meetingId, originMs, speakers: !!job.speakers });
    if (!transcript.utterances.length) throw withUserMessage(new Error(NO_SPEECH), NO_SPEECH);
    storeTranscript(db, meetingId, transcript);
  } catch (err) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    db.setAudioRetained(meetingId, false);
    await rm(audioDir, { recursive: true, force: true });
    err.userMessage ??= `Transcription failed — check that the local speech-to-text sidecar is running. (${err.message})`;
    throw err;
  }
}

/**
 * A FIFO line of async tasks run one at a time; a failed task never blocks the
 * next. Returns run(task) → the task's own promise.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(() => task());
    tail = result.catch(() => {});
    return result;
  };
}

// Imports convert and transcribe one at a time. The sidecar runs two jobs at
// once, so a single import (hours of audio) leaves the other slot free for
// Discord meeting tracks instead of two imports taking both.
const importSlot = createSerialQueue();

async function importPipeline(db, meetingId, job, deps, progress) {
  const meeting = db.getMeeting(meetingId);
  const guildCfg = getGuildConfig(db, meeting.guild_id);
  const cfg = { ...guildCfg, language: job.language || guildCfg.language };
  progress.stage = QUEUED_STAGE;
  let started;
  await deps.queue(() => {
    progress.stage = IMPORT_STAGE;
    started = deps.now();
    return transcribeImport(db, meetingId, { job, cfg, originMs: Date.parse(meeting.started_at), deps });
  });
  progress.completed = 1;
  return finishMeeting(db, meetingId, {
    cfg, summarizer: deps.summarizer ?? getSummarizer(cfg), deliver: job.deliver ?? null, progress,
    timings: { transcribeMs: deps.now() - started, tracks: 1 },
    retainAudio: async () => true, // the converted upload is the recording
  });
}

// Leave a failed import in a failed state with a reason the dashboard can show.
function recordImportFailure(db, meetingId, err) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting || meeting.status === 'done') return;
  if (meeting.status === 'processing') {
    db.setMeetingStatus(meetingId, db.hasUtterances(meetingId) ? 'summary_failed' : 'transcription_failed');
  }
  db.setImportError(meetingId, err?.userMessage || err?.message || String(err));
}

function defaultTranscribe(filePath, opts) {
  // Read live: STT_URL can be changed from the dashboard. One long attempt —
  // re-sending hours of audio after a timeout or crash would only repeat it.
  const transcribe = createSidecarSTT({ baseUrl: config.sttUrl }, { timeoutMs: config.importSttTimeoutMs, retries: 0 });
  return transcribe(filePath, opts);
}

/**
 * Run an import for a meeting created by db.createImportedMeeting. `job`:
 * { uploadPath, language?, speakers?, minSpeakers?, maxSpeakers?, deliver? }.
 * Registers progress at once (stage 'queued' while an earlier import is still
 * transcribing, then 'importing', then the shared summarize stages),
 * always deletes the upload, and on failure records the meeting's
 * import_error and rejects with a userMessage.
 */
export function runImport(db, meetingId, job, deps = {}) {
  const resolved = {
    dataDir: config.dataDir, runFfmpeg, transcribe: defaultTranscribe, now: Date.now,
    queue: importSlot, ...deps,
  };
  // Clean up the original upload before publishing the final failure reason.
  return withMeetingProgress(meetingId, 1, (progress) => importPipeline(db, meetingId, job, resolved, progress))
    .finally(() => rm(job.uploadPath, { force: true }).catch((err) => {
      console.warn(`[import] meeting ${meetingId}: could not delete the upload: ${err.message}`);
    }))
    .catch((err) => {
      recordImportFailure(db, meetingId, err);
      throw err;
    });
}
