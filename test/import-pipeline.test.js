// Imported recordings: convert → sidecar (optionally with speaker detection) →
// per-speaker sentence lines → the shared summarize/deliver path.
import { config } from '../src/config/env.js';
// Filesystem export integration is covered separately in meeting-export.test.js.
config.autoExport = false;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { setVocabulary } from '../src/store/vocabulary.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { meetingProgress } from '../src/pipeline/progress.js';
import { importUtterances, labelSpeakers, runImport, UNKNOWN_SPEAKER } from '../src/pipeline/import.js';

const STARTED = '2026-11-20T10:00:00.000Z';
const ORIGIN = Date.parse(STARTED);
const w = (word, start, end, speaker) => ({ word, start, end, speaker });
const DIARIZED = {
  text: 'Hello there. Hi. Bye.',
  words: [w(' Hello', 0, 0.4, 'SPEAKER_01'), w(' there.', 0.4, 0.9, 'SPEAKER_01'),
    w(' Hi.', 1.5, 1.8, 'SPEAKER_00'), w(' Bye.', 3, 3.5, 'SPEAKER_01')],
  segments: [], speakers: ['SPEAKER_01', 'SPEAKER_00'], language: 'en',
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'parley-import-'));
  const db = openDb(':memory:');
  const meetingId = db.createImportedMeeting({ guildId: 'g1', title: 'Board call', startedAt: STARTED });
  mkdirSync(join(dir, 'imports'));
  const uploadPath = join(dir, 'imports', 'upload.m4a');
  writeFileSync(uploadPath, 'original bytes');
  return { dir, db, meetingId, uploadPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeFfmpeg(calls = []) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    await writeFile(args[args.length - 1], 'mp3 bytes');
    return { stdout: '', stderr: '' };
  };
}

const quietSummarizer = () => new FakeSummarizer();

test('labelSpeakers names speakers in order of first appearance, unknown ones apart', () => {
  const lines = [{ start: 0, end: 1, text: 'a', speaker: 'SPEAKER_03' }, { start: 1, end: 2, text: 'b', speaker: null },
    { start: 2, end: 3, text: 'c', speaker: 'SPEAKER_00' }, { start: 3, end: 4, text: 'd', speaker: 'SPEAKER_03' }];
  assert.deepEqual(labelSpeakers(lines, 7).map(({ userId, displayName }) => [userId, displayName]), [
    ['import-7-1', 'Speaker 1'], ['import-7-0', UNKNOWN_SPEAKER], ['import-7-2', 'Speaker 2'], ['import-7-1', 'Speaker 1']]);
  assert.equal(UNKNOWN_SPEAKER, 'Unknown speaker');
});

test('importUtterances places lines on the epoch timeline with one attendee per speaker', () => {
  const { utterances, attendees, endMs } = importUtterances(DIARIZED, { meetingId: 5, originMs: ORIGIN, speakers: true });
  assert.deepEqual(utterances, [
    { userId: 'import-5-1', displayName: 'Speaker 1', startMs: ORIGIN, endMs: ORIGIN + 900, text: 'Hello there.' },
    { userId: 'import-5-2', displayName: 'Speaker 2', startMs: ORIGIN + 1500, endMs: ORIGIN + 1800, text: 'Hi.' },
    { userId: 'import-5-1', displayName: 'Speaker 1', startMs: ORIGIN + 3000, endMs: ORIGIN + 3500, text: 'Bye.' },
  ]);
  assert.deepEqual(attendees, [{ userId: 'import-5-1', displayName: 'Speaker 1' }, { userId: 'import-5-2', displayName: 'Speaker 2' }]);
  assert.equal(endMs, ORIGIN + 3500);
});

test('without speaker detection every line belongs to Speaker 1', () => {
  const result = { text: 'One. Two.', segments: [{ start: 0, end: 1, text: 'One.', speaker: 'SPEAKER_00' },
    { start: 2, end: 3, text: 'Two.', speaker: 'SPEAKER_01' }] };
  const { utterances, attendees } = importUtterances(result, { meetingId: 9, originMs: ORIGIN, speakers: false });
  assert.deepEqual(utterances.map((u) => [u.userId, u.displayName, u.text]),
    [['import-9-1', 'Speaker 1', 'One.'], ['import-9-1', 'Speaker 1', 'Two.']]);
  assert.deepEqual(attendees, [{ userId: 'import-9-1', displayName: 'Speaker 1' }]);
});

test('runImport converts, detects speakers, summarizes, delivers and keeps the recording', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    setGuildConfig(db, 'g1', { sttProvider: 'openai', sttModel: 'whisper-1', whisperModel: 'medium', language: 'pl' });
    setVocabulary(db, 'Parley\nKubernetes');
    const ffmpeg = [];
    let sttCall = null;
    let progressDuringStt = null;
    const delivered = [];
    const result = await runImport(db, meetingId,
      { uploadPath, language: 'en', speakers: true, minSpeakers: 2, maxSpeakers: 3,
        deliver: async (notes) => delivered.push(notes) },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(ffmpeg), summarizer: quietSummarizer(),
        transcribe: async (path, opts) => { sttCall = { path, opts }; progressDuringStt = meetingProgress(meetingId); return DIARIZED; } });

    const audioDir = join(dir, 'audio', String(meetingId));
    assert.equal(progressDuringStt.stage, 'importing');
    assert.equal(ffmpeg[0].cmd, 'ffmpeg');
    assert.ok(ffmpeg[0].args.includes(uploadPath));
    assert.deepEqual(ffmpeg[0].args.slice(ffmpeg[0].args.indexOf('-ac'), ffmpeg[0].args.indexOf('-ac') + 2), ['-ac', '1']);
    assert.ok(ffmpeg[0].args.includes('libmp3lame'));
    assert.equal(sttCall.path, join(audioDir, 'mixed.mp3'));
    assert.deepEqual(sttCall.opts, { model: 'medium', language: 'en', vocabulary: 'Parley, Kubernetes',
      diarize: true, minSpeakers: 2, maxSpeakers: 3 });
    assert.equal(readFileSync(join(audioDir, 'mixed.mp3'), 'utf8'), 'mp3 bytes');
    assert.deepEqual(JSON.parse(readFileSync(join(audioDir, 'mixed.json'), 'utf8')), { originMs: ORIGIN });
    assert.equal(existsSync(uploadPath), false, 'the upload is deleted');

    const meeting = db.getMeeting(meetingId);
    assert.deepEqual([meeting.status, meeting.audio_retained, meeting.transcription_complete, meeting.import_error],
      ['done', 1, 1, null]);
    assert.equal(meeting.ended_at, new Date(ORIGIN + 3500).toISOString());
    assert.deepEqual(db.listUtterances(meetingId).map((u) => [u.user_id, u.display_name, u.start_ms, u.text]), [
      [`import-${meetingId}-1`, 'Speaker 1', ORIGIN, 'Hello there.'],
      [`import-${meetingId}-2`, 'Speaker 2', ORIGIN + 1500, 'Hi.'],
      [`import-${meetingId}-1`, 'Speaker 1', ORIGIN + 3000, 'Bye.']]);
    assert.deepEqual(db.listAttendees(meetingId).map((a) => a.display_name).sort(), ['Speaker 1', 'Speaker 2']);
    assert.ok(db.getSummary(meetingId).notes.tldr);
    assert.equal(delivered.length, 1);
    assert.equal(db.getMeeting(meetingId).delivery_status, 'posted');
    assert.equal(result.audioRetained, true);
    assert.equal(meetingProgress(meetingId), null);
  } finally { cleanup(); }
});

test('runImport without speaker detection asks for none and files one speaker', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    let opts = null;
    await runImport(db, meetingId, { uploadPath, language: 'auto', speakers: false, minSpeakers: 2 },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(),
        transcribe: async (_path, o) => { opts = o; return { text: 'Hi. Bye.', segments: [
          { start: 0, end: 1, text: 'Hi.' }, { start: 2, end: 3, text: 'Bye.' }] }; } });
    assert.equal(opts.diarize, false);
    assert.equal(opts.minSpeakers, undefined);
    assert.deepEqual(db.listAttendees(meetingId).map((a) => [a.user_id, a.display_name]), [[`import-${meetingId}-1`, 'Speaker 1']]);
    assert.equal(db.getMeeting(meetingId).status, 'done');
  } finally { cleanup(); }
});

test('a missing ffmpeg deletes the upload before publishing the failure reason', async (t) => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    const setImportError = db.setImportError.bind(db);
    t.mock.method(db, 'setImportError', (id, message) => {
      assert.equal(existsSync(uploadPath), false);
      setImportError(id, message);
    });
    const runFfmpeg = async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); };
    await assert.rejects(runImport(db, meetingId, { uploadPath, speakers: false },
      { dataDir: dir, runFfmpeg, summarizer: quietSummarizer(), transcribe: async () => assert.fail('no STT') }),
    (err) => /ffmpeg is not installed/.test(err.userMessage));
    const meeting = db.getMeeting(meetingId);
    assert.equal(meeting.status, 'transcription_failed');
    assert.match(meeting.import_error, /ffmpeg is not installed/);
    assert.equal(meeting.audio_retained, 0);
    assert.equal(existsSync(uploadPath), false);
    assert.equal(meetingProgress(meetingId), null);
  } finally { cleanup(); }
});

test('a file ffmpeg cannot read reports the decoder error', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    const runFfmpeg = async () => { throw Object.assign(new Error('Command failed'), { code: 1,
      stderr: 'upload.m4a: Invalid data found when processing input\n' }); };
    await assert.rejects(runImport(db, meetingId, { uploadPath }, { dataDir: dir, runFfmpeg, summarizer: quietSummarizer() }));
    assert.match(db.getMeeting(meetingId).import_error, /could not be read as audio or video.*Invalid data found/);
  } finally { cleanup(); }
});

test('a sidecar failure marks transcription_failed and drops the converted audio', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    const transcribe = async () => { throw new Error('STT sidecar HTTP 500: CUDA out of memory'); };
    await assert.rejects(runImport(db, meetingId, { uploadPath, speakers: true },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(), transcribe }));
    const meeting = db.getMeeting(meetingId);
    assert.equal(meeting.status, 'transcription_failed');
    assert.match(meeting.import_error, /CUDA out of memory/);
    assert.equal(meeting.audio_retained, 0);
    assert.equal(existsSync(join(dir, 'audio', String(meetingId))), false);
    assert.equal(existsSync(uploadPath), false);
  } finally { cleanup(); }
});

test('a recording with no speech fails transcription with a plain reason', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    await assert.rejects(runImport(db, meetingId, { uploadPath },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(), transcribe: async () => ({ text: '', words: [] }) }));
    assert.equal(db.getMeeting(meetingId).status, 'transcription_failed');
    assert.equal(db.getMeeting(meetingId).import_error, 'No speech was detected in the recording.');
  } finally { cleanup(); }
});

test('a summarizer failure keeps the transcript and recording (summary_failed)', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    const summarizer = { summarize: async () => { throw new Error('quota exceeded'); } };
    await assert.rejects(runImport(db, meetingId, { uploadPath, speakers: true },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer, transcribe: async () => DIARIZED }));
    const meeting = db.getMeeting(meetingId);
    assert.equal(meeting.status, 'summary_failed');
    assert.ok(meeting.import_error);
    assert.equal(meeting.audio_retained, 1);
    assert.equal(db.listUtterances(meetingId).length, 3);
    assert.ok(existsSync(join(dir, 'audio', String(meetingId), 'mixed.mp3')));
  } finally { cleanup(); }
});

test('the default sidecar client uses the import timeout and does not retry it', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  let requests = 0;
  const server = createServer((req) => { requests++; req.resume(); }); // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { sttUrl: config.sttUrl, importSttTimeoutMs: config.importSttTimeoutMs };
  config.sttUrl = `http://127.0.0.1:${server.address().port}`;
  config.importSttTimeoutMs = 200;
  try {
    await assert.rejects(runImport(db, meetingId, { uploadPath, speakers: true },
      { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer() }), /timed out/);
    assert.equal(requests, 1);
    assert.equal(db.getMeeting(meetingId).status, 'transcription_failed');
  } finally {
    Object.assign(config, saved);
    server.closeAllConnections();
    server.close();
    cleanup();
  }
});

test('imports run one at a time: a second import waits as "queued" until the first is transcribed', async () => {
  const { dir, db, meetingId: first, uploadPath, cleanup } = setup();
  try {
    const second = db.createImportedMeeting({ guildId: 'g1', title: 'Second', startedAt: STARTED });
    const secondUpload = join(dir, 'imports', 'second.m4a');
    writeFileSync(secondUpload, 'more bytes');
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const deps = (name, gate) => ({ dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(),
      transcribe: async () => { order.push(`${name}:start`); await gate; order.push(`${name}:end`); return DIARIZED; } });

    const a = runImport(db, first, { uploadPath, speakers: true }, deps('a', firstGate));
    const b = runImport(db, second, { uploadPath: secondUpload, speakers: true }, deps('b', null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(meetingProgress(second).stage, 'queued');
    assert.deepEqual(order, ['a:start']);
    releaseFirst();
    await Promise.all([a, b]);

    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
    assert.equal(db.getMeeting(second).status, 'done');
  } finally { cleanup(); }
});

test('a failed import frees the import slot for the next one', async () => {
  const { dir, db, meetingId: first, uploadPath, cleanup } = setup();
  try {
    const second = db.createImportedMeeting({ guildId: 'g1', title: 'Second', startedAt: STARTED });
    const secondUpload = join(dir, 'imports', 'second.m4a');
    writeFileSync(secondUpload, 'more bytes');
    const failing = { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(),
      transcribe: async () => { throw new Error('sidecar down'); } };
    const working = { dataDir: dir, runFfmpeg: fakeFfmpeg(), summarizer: quietSummarizer(), transcribe: async () => DIARIZED };

    const a = runImport(db, first, { uploadPath, speakers: true }, failing);
    const b = runImport(db, second, { uploadPath: secondUpload, speakers: true }, working);
    await assert.rejects(a, /sidecar down/);
    await b;
    assert.equal(db.getMeeting(second).status, 'done');
  } finally { cleanup(); }
});

test('the upload is opened by ffmpeg with only local file and pipe protocols', async () => {
  const { dir, db, meetingId, uploadPath, cleanup } = setup();
  try {
    const calls = [];
    await runImport(db, meetingId, { uploadPath }, { dataDir: dir, runFfmpeg: fakeFfmpeg(calls),
      summarizer: quietSummarizer(), transcribe: async () => DIARIZED });
    const { args } = calls[0];
    const guard = args.indexOf('-protocol_whitelist');
    assert.ok(guard >= 0 && guard < args.indexOf('-i'), args.join(' '));
    assert.equal(args[guard + 1], 'file,pipe');
  } finally { cleanup(); }
});
