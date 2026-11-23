import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeTracks, vocabularyHint, VOCABULARY_HINT_MAX_CHARS } from '../src/pipeline/transcribe.js';

test('transcribeTracks maps each track to a labeled utterance', async () => {
  const tracks = [
    { userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' },
    { userId: 'u2', displayName: 'Bob', startMs: 2000, pcmPath: '/b.pcm' },
  ];
  const deps = {
    convert: async (pcm, wav) => wav,
    stt: async (wav) => ({ text: wav.includes('a') ? 'hello' : 'hi', words: [{ start: 0, end: 1 }] }),
    cleanup: () => {},
  };
  const { utterances: utts, failures } = await transcribeTracks(tracks, { whisperModel: 'small', language: 'auto' }, deps);
  assert.equal(failures.length, 0);
  assert.equal(utts.length, 2);
  assert.equal(utts[0].displayName, 'Alice');
  assert.equal(utts[0].text, 'hello');
  assert.equal(utts[0].startMs, 0);
});

test('transcribeTracks skips empty transcripts', async () => {
  const tracks = [{ userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' }];
  const deps = { convert: async (p, w) => w, stt: async () => ({ text: '   ', words: [] }), cleanup: () => {} };
  const { utterances: utts, failures } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utts.length, 0);
  assert.equal(failures.length, 0);
});

test('transcribeTracks computes endMs from last word timestamp', async () => {
  const tracks = [{ userId: 'u1', displayName: 'Alice', startMs: 1000, pcmPath: '/a.pcm' }];
  const deps = { convert: async (p, w) => w, stt: async () => ({ text: 'hi there', words: [{ start: 0, end: 0.5 }, { start: 0.6, end: 2.0 }] }), cleanup: () => {} };
  const { utterances: utts } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utts[0].endMs, 1000 + 2000); // startMs + last word end (2.0s)
});

test('transcribeTracks preserves original track order regardless of completion order', async () => {
  const tracks = [
    { userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' },
    { userId: 'u2', displayName: 'Bob', startMs: 1000, pcmPath: '/b.pcm' },
    { userId: 'u3', displayName: 'Cara', startMs: 2000, pcmPath: '/c.pcm' },
    { userId: 'u4', displayName: 'Dan', startMs: 3000, pcmPath: '/d.pcm' },
  ];
  // Slower tracks finish first by inverting the artificial delay per index,
  // so if the pool didn't collect by index, output order would scramble.
  const delays = { '/a.pcm': 30, '/b.pcm': 20, '/c.pcm': 10, '/d.pcm': 0 };
  const deps = {
    concurrency: 4,
    convert: async (p, w) => w,
    stt: async (wav) => {
      await new Promise((r) => setTimeout(r, delays[wav]));
      return { text: `said-${wav}`, words: [{ start: 0, end: 1 }] };
    },
    cleanup: () => {},
  };
  const { utterances: utts } = await transcribeTracks(tracks, {}, deps);
  assert.deepEqual(utts.map((u) => u.userId), ['u1', 'u2', 'u3', 'u4']);
});

test('transcribeTracks respects the concurrency limit (max simultaneous in-flight)', async () => {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    userId: `u${i}`,
    displayName: `User${i}`,
    startMs: i * 1000,
    pcmPath: `/t${i}.pcm`,
  }));
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = {
    concurrency: 3,
    convert: async (p, w) => w,
    stt: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { text: 'hi', words: [{ start: 0, end: 1 }] };
    },
    cleanup: () => {},
  };
  const { utterances: utts } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utts.length, 8);
  assert.ok(maxInFlight <= 3, `expected max in-flight <= 3, got ${maxInFlight}`);
  assert.equal(maxInFlight, 3); // with 8 tracks and pool of 3, should actually saturate
});

test('transcribeTracks defaults concurrency to 4 for openai and 2 otherwise', async () => {
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    userId: `u${i}`,
    displayName: `User${i}`,
    startMs: i * 1000,
    pcmPath: `/t${i}.pcm`,
  }));
  async function measure(cfg) {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = {
      convert: async (p, w) => w,
      stt: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { text: 'hi', words: [{ start: 0, end: 1 }] };
      },
      cleanup: () => {},
    };
    await transcribeTracks(tracks, cfg, deps);
    return maxInFlight;
  }
  assert.equal(await measure({ sttProvider: 'openai' }), 4);
  assert.equal(await measure({ sttProvider: 'sidecar' }), 2);
});

test('transcribeTracks keeps successful tracks when some tracks fail (partial failure)', async () => {
  const tracks = [
    { userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' },
    { userId: 'u2', displayName: 'Bob', startMs: 1000, pcmPath: '/bad.pcm' },
    { userId: 'u3', displayName: 'Cara', startMs: 2000, pcmPath: '/c.pcm' },
  ];
  const deps = {
    convert: async (p, w) => w,
    stt: async (wav) => {
      if (wav.includes('bad')) throw new Error('corrupt pcm');
      return { text: `said-${wav}`, words: [{ start: 0, end: 1 }] };
    },
    cleanup: () => {},
  };
  const { utterances: utts, failures } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utts.length, 2);
  assert.deepEqual(utts.map((u) => u.userId), ['u1', 'u3']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].userId, 'u2');
  assert.match(failures[0].error, /corrupt pcm/);
});

test('transcribeTracks still cleans up the wav file for a failed track', async () => {
  const tracks = [{ userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/bad.pcm' }];
  const cleaned = [];
  const deps = {
    convert: async (p, w) => w,
    stt: async () => { throw new Error('stt exploded'); },
    cleanup: async (p) => { cleaned.push(p); },
  };
  const { utterances, failures } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utterances.length, 0);
  assert.equal(failures.length, 1);
  assert.deepEqual(cleaned, ['/bad.pcm'.replace(/\.pcm$/, '.wav')]);
});

test('transcribeTracks returns all failures (and no utterances) when every track fails', async () => {
  const tracks = [
    { userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' },
    { userId: 'u2', displayName: 'Bob', startMs: 1000, pcmPath: '/b.pcm' },
  ];
  const deps = {
    convert: async (p, w) => w,
    stt: async () => { throw new Error('sidecar down'); },
    cleanup: () => {},
  };
  const { utterances, failures } = await transcribeTracks(tracks, {}, deps);
  assert.equal(utterances.length, 0);
  assert.equal(failures.length, 2);
});

test('vocabularyHint keeps the first whole terms that fit the hint budget', () => {
  // faster-whisper keeps ~223 hotword tokens and OpenAI the last 224 prompt
  // tokens, so a 64 KB list was resent per track for nothing.
  const terms = Array.from({ length: 5000 }, (_, i) => `Term${i}`);
  const hint = vocabularyHint(terms.join('\n'));
  assert.ok(hint.length <= VOCABULARY_HINT_MAX_CHARS);
  assert.ok(hint.startsWith('Term0, Term1, Term2'));
  assert.deepEqual(hint.split(', '), terms.slice(0, hint.split(', ').length)); // whole terms, in order
  assert.equal(vocabularyHint(terms.join('\n')), hint); // deterministic
  assert.equal(vocabularyHint('AWP\n\nconnector'), 'AWP, connector');
  assert.equal(vocabularyHint(''), '');
});

test('transcribeTracks sends the capped vocabulary hint to the STT provider', async () => {
  const seen = [];
  const terms = Array.from({ length: 3000 }, (_, i) => `Name${i}`).join('\n');
  await transcribeTracks([{ userId: 'u1', displayName: 'A', startMs: 0, pcmPath: '/a.pcm' }],
    { transcriptionVocabulary: terms }, {
      convert: async (p, w) => w, cleanup: () => {},
      sttDeps: { fetchImpl: async (_url, init) => { seen.push(init.body.get('vocabulary')); return { ok: true, json: async () => ({ text: 'x', words: [] }) }; },
        readFile: async () => Buffer.from('RIFF') },
      env: { sttUrl: 'http://stt' },
    });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].length <= VOCABULARY_HINT_MAX_CHARS);
  assert.ok(seen[0].startsWith('Name0, Name1'));
});

test('a track is uploaded as WAV straight from its PCM file, with no WAV copy written to disk', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'parley-wavless-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pcmPath = join(dir, 'u1_1000.pcm');
  writeFileSync(pcmPath, Buffer.alloc(3200, 7));
  let body = Buffer.alloc(0);
  let filesDuringUpload = null;
  const server = createServer((req, res) => {
    filesDuringUpload = readdirSync(dir);
    req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'hi', words: [{ word: ' hi', start: 0, end: 0.1 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { utterances, failures } = await transcribeTracks(
    [{ userId: 'u1', displayName: 'Al', startMs: 1000, pcmPath }], {},
    { env: { sttUrl: `http://127.0.0.1:${server.address().port}` } });

  assert.deepEqual(failures, []);
  assert.equal(utterances.length, 1);
  assert.deepEqual(filesDuringUpload, ['u1_1000.pcm'], 'no WAV copy on disk');
  const text = body.toString('latin1');
  assert.match(text, /filename="u1_1000\.wav"/);
  const riff = body.indexOf('RIFF');
  assert.ok(riff > 0);
  assert.equal(body.readUInt32LE(riff + 40), 3200, 'WAV data length is the PCM size');
  assert.equal(body.subarray(riff + 44, riff + 44 + 3200).every((b) => b === 7), true);
  assert.ok(existsSync(pcmPath), 'the PCM is kept');
});
