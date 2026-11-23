// Speaker detection (diarization) support in the sidecar STT client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeFile, sidecarCapability, OUTDATED_SIDECAR_REASON } from '../src/adapters/stt-client.js';
import { createSidecarSTT } from '../src/adapters/stt/sidecar.js';

const fakeRead = async () => Buffer.from('ID3fake');

function capturingFetch(body = { text: 'hi', words: [], segments: [], speakers: [] }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: init.body });
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('transcribeFile asks for speaker detection and passes speaker bounds', async () => {
  const { calls, fetchImpl } = capturingFetch();
  await transcribeFile('/tmp/mixed.mp3', { model: 'small', language: 'en', diarize: true, minSpeakers: 2, maxSpeakers: 4 },
    { baseUrl: 'http://stt', fetchImpl, readFile: fakeRead });
  const form = calls[0].form;
  assert.equal(calls[0].url, 'http://stt/transcribe');
  assert.equal(form.get('diarize'), 'true');
  assert.equal(form.get('min_speakers'), '2');
  assert.equal(form.get('max_speakers'), '4');
  assert.equal(form.get('model'), 'small');
});

test('transcribeFile sends no diarization fields for ordinary transcription', async () => {
  const { calls, fetchImpl } = capturingFetch();
  await transcribeFile('/tmp/a.wav', { model: 'small' }, { baseUrl: 'http://stt', fetchImpl, readFile: fakeRead });
  const form = calls[0].form;
  for (const field of ['diarize', 'min_speakers', 'max_speakers']) assert.equal(form.get(field), null, field);
});

test('transcribeFile can explicitly turn speaker detection off (no speaker bounds sent)', async () => {
  const { calls, fetchImpl } = capturingFetch();
  await transcribeFile('/tmp/mixed.mp3', { diarize: false, minSpeakers: 2, maxSpeakers: 4 },
    { baseUrl: 'http://stt', fetchImpl, readFile: fakeRead });
  const form = calls[0].form;
  assert.equal(form.get('diarize'), 'false');
  assert.equal(form.get('min_speakers'), null);
  assert.equal(form.get('max_speakers'), null);
});

test('a sidecar 400 surfaces its JSON detail and is not retried', async () => {
  let calls = 0;
  const detail = 'Speaker detection is not enabled on this sidecar: no Hugging Face token';
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 400, text: async () => JSON.stringify({ detail }) };
  };
  await assert.rejects(
    transcribeFile('/tmp/a.mp3', { diarize: true }, { baseUrl: 'http://stt', fetchImpl, readFile: fakeRead, retries: 2, backoffMs: 0 }),
    (err) => err.message === `STT sidecar HTTP 400: ${detail}` && err.noRetry === true,
  );
  assert.equal(calls, 1);
});

test('a non-JSON error body is still quoted as is', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'plain failure' });
  await assert.rejects(transcribeFile('/tmp/a.mp3', {}, { baseUrl: 'http://stt', fetchImpl, readFile: fakeRead }),
    /STT sidecar HTTP 400: plain failure$/);
});

test('the sidecar adapter forwards speaker detection options', async () => {
  const { calls, fetchImpl } = capturingFetch();
  const transcribe = createSidecarSTT({ baseUrl: 'http://stt' }, { fetchImpl, readFile: fakeRead });
  await transcribe('/tmp/mixed.mp3', { model: 'base', diarize: true, minSpeakers: 1, maxSpeakers: 3 });
  assert.equal(calls[0].form.get('diarize'), 'true');
  assert.equal(calls[0].form.get('min_speakers'), '1');
  assert.equal(calls[0].form.get('max_speakers'), '3');
});

const healthFetch = (status, body) => async (url) => {
  assert.equal(url, 'http://stt/health');
  return { ok: status < 400, status, json: async () => body };
};

test('sidecarCapability reports a reachable sidecar with speaker detection', async () => {
  const result = await sidecarCapability({ baseUrl: 'http://stt',
    fetchImpl: healthFetch(200, { status: 'ok', diarization: { available: true, reason: null } }) });
  assert.deepEqual(result, { available: true, speakerDetection: true, reason: null });
});

test('sidecarCapability passes on the sidecar reason when speaker detection is off', async () => {
  const result = await sidecarCapability({ baseUrl: 'http://stt',
    fetchImpl: healthFetch(200, { diarization: { available: false, reason: 'pyannote.audio is not installed' } }) });
  assert.deepEqual(result, { available: true, speakerDetection: false, reason: 'pyannote.audio is not installed' });
});

test('sidecarCapability: an older sidecar without the field can import but not detect speakers', async () => {
  const result = await sidecarCapability({ baseUrl: 'http://stt', fetchImpl: healthFetch(200, { status: 'ok' }) });
  assert.deepEqual(result, { available: true, speakerDetection: false, reason: OUTDATED_SIDECAR_REASON });
  assert.equal(OUTDATED_SIDECAR_REASON, "This sidecar version doesn't support speaker detection; update it to the -full image.");
});

test('sidecarCapability: an unreachable or failing sidecar cannot import at all', async () => {
  const down = await sidecarCapability({ baseUrl: 'http://stt',
    fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.available, false);
  assert.equal(down.speakerDetection, false);
  assert.match(down.reason, /not reachable/);

  const broken = await sidecarCapability({ baseUrl: 'http://stt', fetchImpl: healthFetch(503, {}) });
  assert.deepEqual([broken.available, broken.speakerDetection], [false, false]);
  assert.match(broken.reason, /HTTP 503/);

  const garbled = await sidecarCapability({ baseUrl: 'http://stt',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) });
  assert.deepEqual([garbled.available, garbled.speakerDetection], [false, false]);
  assert.match(garbled.reason, /unreadable/);
});

test('sidecarCapability gives up after its short timeout', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const result = await sidecarCapability({ baseUrl: 'http://stt', fetchImpl, timeoutMs: 20 });
  assert.equal(result.available, false);
  assert.match(result.reason, /did not answer/);
});
