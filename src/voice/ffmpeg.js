// src/voice/ffmpeg.js
// Run ffmpeg for imports and recording archives. Unlike execFile, stderr is not
// buffered whole (a noisy, damaged file can print megabytes of decode errors,
// which used to hit execFile's maxBuffer and kill ffmpeg): only its last few
// KiB are kept, for the error message.
import { spawn } from 'node:child_process';

// Read inputs only from local files (or a pipe): an uploaded playlist or
// concat list must not make ffmpeg fetch URLs (SSRF) or other protocols.
export const FFMPEG_INPUT_GUARD = Object.freeze(['-protocol_whitelist', 'file,pipe']);
const STDERR_TAIL_BYTES = 8 * 1024;

const keepTail = (text, chunk) => (text + chunk).slice(-STDERR_TAIL_BYTES);

function failure(message, props) {
  return Object.assign(new Error(message), props);
}

/**
 * Run `cmd args` (normally 'ffmpeg'). Resolves { stderr } (its tail) on exit
 * code 0. Rejects with an Error carrying `code` (exit code, or 'ENOENT' when
 * the binary is missing), `killed` (timed out) and `stderr` (tail).
 */
export function runFfmpeg(cmd, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let killed = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = timeout > 0 ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout) : null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = keepTail(stderr, chunk); });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stderr, killed }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stderr });
      reject(failure(`${cmd} exited with ${code ?? signal}`, { code: code ?? signal, signal, killed, stderr }));
    });
  });
}
