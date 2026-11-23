// HTTP helpers shared by adapters that wait a long time for one response.
//
// Node's built-in fetch gives up waiting for response *headers* after 300s
// (undici's default headersTimeout), no matter how long an AbortSignal allows.
// The STT sidecar and Ollama (stream:false) send headers only once the whole job
// is done, so a long transcription/summary was cut off at 5 minutes and then
// retried while the server was still working on the first copy. A dispatcher
// whose header/body timeouts match the caller's own deadline fixes that.
//
// undici is the library behind Node's fetch; it is already installed (discord.js
// depends on it). Its own fetch is used with its own Agent so the two always
// come from the same version.
import { openAsBlob } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

const agents = new Map(); // timeoutMs -> Agent (reused so connections are pooled)

function agentFor(timeoutMs) {
  if (!agents.has(timeoutMs)) {
    agents.set(timeoutMs, new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }));
  }
  return agents.get(timeoutMs);
}

/** A fetch whose wait for headers and between body chunks is `timeoutMs`. */
export function fetchWithTimeouts(timeoutMs) {
  const dispatcher = agentFor(timeoutMs);
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);

/** True for an AbortSignal.timeout() abort or an undici header/body/connect timeout. */
export function isTimeoutError(err) {
  if (!err) return false;
  return err.name === 'TimeoutError' || TIMEOUT_CODES.has(err.code) || TIMEOUT_CODES.has(err.cause?.code);
}

/**
 * The file as a Blob that streams from disk when sent, instead of reading a
 * (possibly 100+ MB) track into memory. An injected `readFile` (tests,
 * in-memory audio) still works.
 */
export async function fileBlob(filePath, { readFile } = {}) {
  if (readFile) return new Blob([await readFile(filePath)]);
  return openAsBlob(filePath);
}

/**
 * Read (and so release) an error response's body, returning a short snippet
 * for the error message. Never throws: the status is what matters.
 */
export async function errorBodySnippet(res, max = 200) {
  try {
    return (await res.text()).trim().slice(0, max);
  } catch {
    return '';
  }
}

/**
 * Run `work`, turning a timeout into an error that says who didn't answer and
 * for how long (instead of undici's bare "fetch failed").
 */
export async function withTimeoutMessage(work, label, timeoutMs) {
  try {
    return await work();
  } catch (err) {
    if (!isTimeoutError(err)) throw err;
    throw new Error(`${label} did not answer within ${Math.round(timeoutMs / 1000)}s.`, { cause: err });
  }
}
