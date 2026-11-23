// Mix a meeting's per-turn PCM tracks (s16le/16kHz/mono, one file per speaking
// turn — see capture.js) into a single meeting-long WAV for download. Tracks
// are placed on a shared timeline by their epoch-ms start offsets (from the
// filename) and summed sample-wise with clamping where speakers overlap.
//
// I/O is chunked read-modify-write against a pre-sized output file, so memory
// stays bounded no matter how long the meeting ran (a WAV hour is ~115 MB).
import { existsSync, readdirSync } from 'node:fs';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parsePcmName, wavHeader } from './audio.js';

const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_MS = 16; // 16 kHz mono
const CHUNK = 1 << 20; // 1 MiB per read-modify-write window

export const MIXED_WAV_NAME = 'mixed.wav';
// Where the mixed recording starts on the meeting timeline: { originMs } (epoch
// ms of 0 s in the audio). Kept beside the archived MP3 after the raw tracks
// are deleted, so transcript lines can still seek the recording.
export const MIX_ORIGIN_NAME = 'mixed.json';

// Tracks with at least one sample; empty ones don't take part in the mix.
async function sizedTracks(tracks) {
  const sized = [];
  for (const t of tracks) {
    const { size } = await stat(t.path).catch(() => ({ size: 0 }));
    const bytes = size - (size % BYTES_PER_SAMPLE); // ignore a trailing odd byte
    if (bytes >= BYTES_PER_SAMPLE) sized.push({ ...t, bytes });
  }
  return sized;
}

// The meeting dir's raw per-turn tracks, timed from their filenames.
function dirTracks(audioDir) {
  let files = [];
  try { files = readdirSync(audioDir).filter((f) => f.endsWith('.pcm')); }
  catch { return []; } // dir gone → no audio
  return files
    .map((f) => ({ path: join(audioDir, f), startMs: parsePcmName(f).startMs }))
    .filter((t) => Number.isFinite(t.startMs));
}

const earliestStart = (tracks) => (tracks.length ? Math.min(...tracks.map((t) => t.startMs)) : null);

// The start of the earliest non-empty track. Tracks are tried in time order,
// so usually one stat() answers it instead of one per speaking turn.
async function earliestAudibleStart(tracks) {
  for (const track of [...tracks].sort((a, b) => a.startMs - b.startMs)) {
    if ((await sizedTracks([track])).length) return track.startMs;
  }
  return null;
}

/** Epoch ms at which the meeting's mixed recording starts, or null if unknown. */
export async function recordingOriginMs(audioDir) {
  try {
    const { originMs } = JSON.parse(await readFile(join(audioDir, MIX_ORIGIN_NAME), 'utf8'));
    if (Number.isFinite(originMs)) return originMs;
  } catch { /* not mixed yet, or archived before origins were recorded */ }
  return earliestAudibleStart(dirTracks(audioDir));
}

/**
 * Mix tracks [{ path, startMs }] into a WAV at outPath.
 * Returns outPath, or null when there is nothing to mix.
 */
export async function mixTracksToWav(tracks, outPath, { onOrigin } = {}) {
  const sized = await sizedTracks(tracks);
  if (sized.length === 0) return null;

  const t0 = earliestStart(sized);
  onOrigin?.(t0);
  for (const t of sized) t.offsetBytes = (t.startMs - t0) * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
  const totalBytes = Math.max(...sized.map((t) => t.offsetBytes + t.bytes));

  const out = await open(outPath, 'w+', 0o600);
  try {
    await out.write(wavHeader(totalBytes), 0, 44, 0);
    // Extending via truncate zero-fills, so silence between turns needs no writes.
    await out.truncate(44 + totalBytes);
    for (const t of sized) {
      const src = await open(t.path, 'r');
      try {
        for (let pos = 0; pos < t.bytes; pos += CHUNK) {
          const len = Math.min(CHUNK, t.bytes - pos);
          const inBuf = Buffer.alloc(len);
          await src.read(inBuf, 0, len, pos);
          const outPos = 44 + t.offsetBytes + pos;
          const outBuf = Buffer.alloc(len);
          await out.read(outBuf, 0, len, outPos);
          for (let i = 0; i < len; i += BYTES_PER_SAMPLE) {
            const sum = outBuf.readInt16LE(i) + inBuf.readInt16LE(i);
            outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
          }
          await out.write(outBuf, 0, len, outPos);
        }
      } finally { await src.close(); }
    }
  } finally { await out.close(); }
  return outPath;
}

/**
 * Return the path of the meeting dir's mixed WAV, building it from the .pcm
 * tracks on first call (the result is cached next to them as mixed.wav).
 * Returns null when the dir has no usable audio.
 */
export async function ensureMixedWav(audioDir) {
  const outPath = join(audioDir, MIXED_WAV_NAME);
  if (existsSync(outPath)) return outPath;

  const tracks = dirTracks(audioDir);
  if (tracks.length === 0) return null;

  // Build under a temp name so a crash mid-mix can never serve a half-written WAV.
  const tmpPath = `${outPath}.${randomUUID()}.tmp`;
  try {
    const mixed = await mixTracksToWav(tracks, tmpPath);
    if (!mixed) return null;
    const originMs = earliestStart(await sizedTracks(tracks));
    await writeFile(join(audioDir, MIX_ORIGIN_NAME), JSON.stringify({ originMs }), { mode: 0o600 });
    await rename(tmpPath, outPath);
    return outPath;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
