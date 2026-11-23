// src/web/import-routes.js
// Dashboard API for importing a recording made outside Discord. The upload is
// the raw request body (no multipart, no extra dependencies), streamed to
// DATA_DIR/imports/ under a hard size cap; the import itself then runs in the
// background (src/pipeline/import.js) and reports through the usual
// GET /meetings/:id/progress. Mounted onto the main router by apiRouter.
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, IMPORT_UPLOADS_DIR } from '../config/env.js';
import { sidecarCapability } from '../adapters/stt-client.js';
import { LANGUAGE_CODES } from '../adapters/summarizer/languages.js';
import { postNotes } from '../delivery/post.js';
import { runImport } from '../pipeline/import.js';
import { getGuildConfig } from '../store/config.js';
import { requireAdmin } from './auth.js';
import { intQuery, isSingleQuery } from './api-input.js';

export const DEFAULT_IMPORT_TITLE = 'Imported recording';
// How long an admin's recording upload may take to arrive. The server's
// default deadline (5 minutes, request-deadline.js) would cut off a
// multi-gigabyte upload on a normal link; only this request gets longer.
export const IMPORT_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// An upload that sends nothing for this long is treated as abandoned.
export const IMPORT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const TITLE_MAX = 100;
const SPEAKERS_MAX = 20;
const QUERY_FIELDS = ['title', 'startedAt', 'language', 'post', 'filename', 'speakers', 'minSpeakers', 'maxSpeakers'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const MEDIA_TYPE = /^(audio|video)\/[\w.+-]+$/;
const EMPTY_BODY = 'The upload is empty. Choose a recording file.';

class ImportInputError extends Error {}
const invalid = (message) => { throw new ImportInputError(message); };

function titleOf(raw = '') {
  const title = raw.trim();
  if (!title) return DEFAULT_IMPORT_TITLE;
  if (title.length > TITLE_MAX || /[\x00-\x1f\x7f]/.test(title)) {
    invalid(`title must be at most ${TITLE_MAX} characters, without line breaks.`);
  }
  return title;
}

function startedAtOf(raw, now) {
  if (!raw) return new Date(now()).toISOString();
  const ms = ISO_DATE.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) invalid('startedAt must be an ISO 8601 date and time, e.g. 2026-11-20T14:30:00Z.');
  return new Date(ms).toISOString();
}

function languageOf(raw, fallback) {
  if (!raw) return fallback;
  if (!LANGUAGE_CODES.has(raw)) invalid(`Invalid language. Use one of: ${[...LANGUAGE_CODES].join(', ')}.`);
  return raw;
}

function flagOf(raw, name) {
  if ([undefined, '', '0', 'false'].includes(raw)) return false;
  if (raw === '1' || raw === 'true') return true;
  return invalid(`${name} must be 1 or 0.`);
}

function speakerCountOf(raw, name) {
  const n = intQuery(raw || undefined, SPEAKERS_MAX, null);
  if (Number.isNaN(n)) invalid(`${name} must be a whole number from 1 to ${SPEAKERS_MAX}.`);
  return n;
}

// Speaker bounds only mean something when speaker detection is asked for.
function speakerBoundsOf(query, speakers) {
  if (!speakers) return { minSpeakers: null, maxSpeakers: null };
  const minSpeakers = speakerCountOf(query.minSpeakers, 'minSpeakers');
  const maxSpeakers = speakerCountOf(query.maxSpeakers, 'maxSpeakers');
  if (minSpeakers && maxSpeakers && minSpeakers > maxSpeakers) invalid('minSpeakers cannot be more than maxSpeakers.');
  return { minSpeakers, maxSpeakers };
}

// Only the extension of the original name is used (ffmpeg may need the hint).
function extensionOf(filename = '') {
  const ext = extname(filename).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
}

/** Validated import options from the query string, or { error }. */
export function parseImportQuery(query, cfg, now = Date.now) {
  try {
    if (QUERY_FIELDS.some((field) => !isSingleQuery(query[field]))) invalid('Send each import option at most once.');
    const speakers = flagOf(query.speakers, 'speakers');
    const post = flagOf(query.post, 'post');
    if (post && !cfg.notesChannelId) invalid('Choose a notes channel in Settings before posting imported recordings to Discord.');
    return {
      title: titleOf(query.title), startedAt: startedAtOf(query.startedAt, now),
      language: languageOf(query.language, cfg.language), post, speakers,
      ...speakerBoundsOf(query, speakers), ext: extensionOf(query.filename),
    };
  } catch (err) {
    if (err instanceof ImportInputError) return { error: err.message };
    throw err;
  }
}

/** Why a request body can't be an uploaded recording, or null. */
export function bodyTypeError(header) {
  if (!header) return null;
  const type = header.split(';')[0].trim().toLowerCase();
  if (type === 'application/octet-stream' || type === 'application/ogg' || MEDIA_TYPE.test(type)) return null;
  return 'Send the recording file itself as the request body (audio/*, video/* or application/octet-stream).';
}

const tooLargeMessage = (maxBytes) => `The recording is larger than the ${Math.floor(maxBytes / 1024 ** 2)} MiB import limit.`;

class UploadTooLarge extends Error {}

const UPLOAD_INTERRUPTED = 'The upload was interrupted.';
const clientGone = (req) => req.destroyed || req.readableAborted || (req.socket?.destroyed ?? false);

// The body is read through a PassThrough so that refusing it mid-stream never
// destroys the request itself (which would cut the connection before the
// client could read the 413). A client that goes away still fails the copy —
// also one that left before this was attached (its 'close' already fired).
function detachedBody(req) {
  const body = new PassThrough();
  if (clientGone(req) && !req.complete) {
    body.destroy(new Error(UPLOAD_INTERRUPTED));
    return body;
  }
  req.once('error', (err) => body.destroy(err));
  req.once('close', () => { if (!req.complete) body.destroy(new Error(UPLOAD_INTERRUPTED)); });
  req.pipe(body);
  return body;
}

// Stream the body to a fresh file, stopping at maxBytes. The partial file is
// removed on any failure (too large, client gone, disk full).
async function saveUpload(req, { dir, ext, maxBytes }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${ext}`);
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new UploadTooLarge() : null, chunk);
    },
  });
  try {
    await pipeline(detachedBody(req), cap, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    return { path, bytes };
  } catch (err) {
    await rm(path, { force: true });
    if (err instanceof UploadTooLarge) req.resume(); // discard the rest; nothing more is stored
    throw err;
  }
}

// Close the connection on every refusal: the client may still be sending a
// large body that nobody will read. What still arrives is discarded until then.
function refuse(req, res, status, error) {
  req.resume();
  return res.set('Connection', 'close').status(status).json({ error });
}

function capabilityError(capability, speakers) {
  if (!capability.available) return capability.reason || 'The local speech-to-text sidecar is not available.';
  if (speakers && !capability.speakerDetection) return capability.reason || 'Speaker detection is not available.';
  return null;
}

// Like a retry: post only when the bot is connected now, and fail visibly
// (delivery status) if it is gone by the time the notes are ready.
function discordDelivery(db, liveClient, meetingId) {
  if (!liveClient()) return null;
  return async (notes, talktime) => {
    const client = liveClient();
    if (!client) throw new Error('The Discord bot is disconnected.');
    const meeting = db.getMeeting(meetingId);
    await postNotes({ client, meeting, cfg: getGuildConfig(db, meeting.guild_id), notes, talktime });
  };
}

export function mountImportRoutes(r, {
  db, liveClient, capability = () => sidecarCapability(), startImport = runImport,
  dataDir = config.dataDir, maxBytes = config.importMaxBytes, log = console,
}) {
  const isKnownGuild = (guildId) => db.isKnownGuild(guildId) || !!liveClient()?.guilds?.cache?.has?.(guildId);

  r.get('/imports/capability', async (_req, res) => {
    res.json({ ...(await capability()), maxBytes });
  });

  // Checks that need no body come first, so a doomed upload is refused before
  // it is sent (the dashboard also checks /imports/capability up front).
  async function precheck(req) {
    if (!isKnownGuild(req.params.g)) return { status: 404, error: 'Unknown server.' };
    const typeError = bodyTypeError(req.headers['content-type']);
    if (typeError) return { status: 415, error: typeError };
    const options = parseImportQuery(req.query, getGuildConfig(db, req.params.g));
    if (options.error) return { status: 400, error: options.error };
    const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (declared === 0) return { status: 400, error: EMPTY_BODY };
    if (declared > maxBytes) return { status: 413, error: tooLargeMessage(maxBytes) };
    const unavailable = capabilityError(await capability(), options.speakers);
    return unavailable ? { status: 409, error: unavailable } : { options };
  }

  async function receive(req, res, options) {
    try {
      const saved = await saveUpload(req, { dir: join(dataDir, IMPORT_UPLOADS_DIR), ext: options.ext, maxBytes });
      if (saved.bytes > 0) return saved;
      await rm(saved.path, { force: true });
      refuse(req, res, 400, EMPTY_BODY);
    } catch (err) {
      // The rest of a too-large body is discarded as it arrives (saveUpload
      // resumed it); the connection closes after the 413.
      if (err instanceof UploadTooLarge) return void refuse(req, res, 413, tooLargeMessage(maxBytes));
      if (clientGone(req)) {
        req.destroy();
        return void log.error?.('[import] upload aborted by the client.');
      }
      // Anything else (disk full…) ends in a 500 from the error handler; don't
      // keep reading the body or reuse the connection.
      res.set('Connection', 'close');
      req.resume();
      throw err;
    }
    return null;
  }

  // Only now (signed-in admin, options valid, sidecar ready) may the upload
  // take longer than the server's default request deadline.
  function allowLongUpload(req) {
    req.extendDeadline?.(IMPORT_REQUEST_TIMEOUT_MS);
    req.setTimeout?.(IMPORT_IDLE_TIMEOUT_MS);
  }

  r.post('/guilds/:g/imports', requireAdmin, async (req, res) => {
    const { status, error, options } = await precheck(req);
    if (error) return refuse(req, res, status, error);
    allowLongUpload(req);
    const upload = await receive(req, res, options);
    if (!upload) return;
    const { title, startedAt, language, speakers, minSpeakers, maxSpeakers, post } = options;
    const meetingId = db.createImportedMeeting({ guildId: req.params.g, title, startedAt });
    const deliver = post ? discordDelivery(db, liveClient, meetingId) : null;
    // startImport registers progress synchronously, so a poll right after
    // this response already sees the import running.
    startImport(db, meetingId, { uploadPath: upload.path, language, speakers, minSpeakers, maxSpeakers, deliver })
      .catch((err) => log.error(`[import] meeting ${meetingId} failed: ${err?.userMessage || err?.message || err}`));
    res.status(202).json({ ok: true, meetingId });
  });
}
