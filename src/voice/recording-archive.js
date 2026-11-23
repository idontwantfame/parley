import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureMixedWav, MIXED_WAV_NAME } from './mix.js';

export const MP3_NAME = 'mixed.mp3';
const encode = promisify(execFile);

export async function archiveRecording(audioDir, { transcriptionComplete, run = encode } = {}) {
  const output = join(audioDir, MP3_NAME);
  if (!existsSync(output)) {
    const wav = await ensureMixedWav(audioDir);
    if (!wav) return null;
    const temporary = join(audioDir, `.${randomUUID()}.mp3`);
    try {
      await (await open(temporary, 'wx', 0o600)).close();
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', wav,
        '-codec:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', temporary], { timeout: 900_000 });
      if ((await stat(temporary)).size === 0) throw new Error('The MP3 encoder returned an empty recording.');
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await rm(join(audioDir, MIXED_WAV_NAME), { force: true });
  if (transcriptionComplete) {
    const files = await readdir(audioDir);
    await Promise.all(files.filter((file) => file.endsWith('.pcm')).map((file) => rm(join(audioDir, file), { force: true })));
  }
  return output;
}

export async function retainRecording(audioDir, transcriptionComplete, meetingId) {
  try {
    return !!await archiveRecording(audioDir, { transcriptionComplete });
  } catch (error) {
    console.warn(`[audio] meeting ${meetingId}: MP3 archive failed, retaining original audio: ${error.message}`);
    return true;
  }
}

/**
 * May finalize delete the meeting's audio dir (keepAudio off)? Only when the
 * pipeline finished, nothing was archived, and the transcript is complete — a
 * partial transcript keeps the PCM so a retry can re-transcribe the speakers
 * that failed. `meeting` is the row after the pipeline ran.
 */
export function canDiscardAudio(result, meeting) {
  if (!result || result.audioRetained) return false;
  return meeting?.transcription_complete === 1;
}
