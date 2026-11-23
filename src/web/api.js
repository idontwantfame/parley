// src/web/api.js
import { Router } from 'express';
import { ChannelType } from 'discord.js';
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureMixedWav } from '../voice/mix.js';
import { MP3_NAME } from '../voice/recording-archive.js';
import { getGuildConfig, setGuildConfig } from '../store/config.js';
import { getVocabulary, setVocabulary } from '../store/vocabulary.js';
import { validateSetup, availableProviders } from '../commands/setup-logic.js';
import { config as env } from '../config/env.js';
import { askMeeting } from '../adapters/summarizer/ask.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { buildTranscript, computeTalkTime } from '../pipeline/summarize.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { SUMMARY_PROMPT } from '../adapters/summarizer/notes.js';
import { DEFAULT_OVERVIEW_PROMPT } from '../adapters/summarizer/ollama.js';
import { listModels, clearModelCache, DEFAULT_MODELS, CATALOG_PROVIDERS } from '../adapters/summarizer/models.js';
import { secretStatus, setProviderKey, isSecretProvider, connectionStatus, setConnection, redactUrl } from '../store/secrets.js';
import { COMMAND_CATALOG } from '../commands/definitions.js';
import { retryMeeting, retryPlan, retryEligible, regeneratePlan, regenerateSummary } from '../pipeline/retry.js';
import { availableSttProviders } from '../adapters/stt/index.js';
import { isAdminRequest, requireAdmin } from './auth.js';
import { readMeetingExport, meetingExportBasename, renderMeetingMarkdown, autoExportMeeting } from '../delivery/meeting-export.js';
import { campaignContextFor } from '../campaign/journal.js';
import { meetingProgress, withMeetingProgress } from '../pipeline/progress.js';
import { postNotes } from '../delivery/post.js';
import { deliverSavedNotes } from '../delivery/status.js';
import { pruneMeetings, removeMeetingArtifacts } from '../store/meeting-retention.js';
import {
  ADMIN_CONFIG_FIELDS, MEETING_PAGE_MAX, configInputError, intQuery, isSingleQuery, questionOf,
} from './api-input.js';
import { mountCampaignRoutes } from './campaign-routes.js';

function audioDir(id) {
  return join(env.dataDir, 'audio', String(id));
}

function guildName(client, id, dbNames = {}) {
  return client?.guilds?.cache?.get(id)?.name || dbNames[id] || id;
}

// Does any configured guild still use the local sidecar for transcription?
// Default provider is 'sidecar', so an unconfigured guild counts as sidecar.
function anyGuildUsesSidecar(db) {
  try {
    const rows = db.sql.prepare(`SELECT stt_provider FROM guild_config`).all();
    if (rows.length === 0) return true;
    return rows.some((row) => (row.stt_provider ?? 'sidecar') === 'sidecar');
  } catch { return true; }
}

// Guard middleware: admin-only when the body touches any of `fields`.
function requireAdminForFields(fields) {
  return (req, res, next) => (fields.some((field) => req.body?.[field] !== undefined)
    ? requireAdmin(req, res, next) : next());
}

const artifactDirs = () => ({ dataDir: env.dataDir, exportDir: env.exportDir });

export function apiRouter({ db, bot = null, client = null, sidecar = null, mixAudio = ensureMixedWav }) {
  const r = Router();
  // Meeting ids with a summary regeneration in flight (guards double-submits).
  const regeneration = new Map();
  // Meeting id -> in-flight WAV mix, so concurrent downloads share one mix.
  const mixes = new Map();
  // The live Discord client may not exist yet (bot starts lazily once creds are
  // set). Always resolve it fresh from the controller so routes pick it up the
  // moment the bot connects, without rebuilding the router. `client` is still
  // accepted directly for tests and the standalone server.
  const liveClient = () => bot?.client || client;
  const botSessions = () => (bot && typeof bot.liveMeetings === 'function' ? bot.liveMeetings() : []);

  // Why a meeting can't be deleted/merged/retried/regenerated right now, or
  // null. Live capture writes into the meeting's audio folder, so recording
  // (or bot-side processing) meetings must never be touched.
  function busyReason(meeting) {
    if (meeting.status === 'recording' || botSessions().some((s) => Number(s.meetingId) === meeting.id)) {
      return 'This meeting is still being recorded or processed.';
    }
    if (meetingProgress(meeting.id) || regeneration.get(meeting.id)?.state === 'running') {
      return 'This meeting is already being processed.';
    }
    if (meeting.delivery_status === 'sending') return 'Discord delivery is in progress.';
    return null;
  }

  function mixOnce(id) {
    if (!mixes.has(id)) mixes.set(id, Promise.resolve().then(() => mixAudio(audioDir(id))).finally(() => mixes.delete(id)));
    return mixes.get(id);
  }

  // Active recordings for a guild, enriched with the voice channel's current
  // members (so the UI can show who's live). Reads in-memory bot sessions; empty
  // when no bot is attached (e.g. the standalone read-only server). Sessions
  // carry a `phase`: 'recording' (capture in progress) or 'processing'
  // (recording stopped, transcribe/summarize pipeline still running).
  function liveMeetings(guildId) {
    const sessions = botSessions().filter((s) => s.guildId === guildId);
    const c = liveClient();
    return sessions.map((s) => {
      let attendees = db.listAttendees(s.meetingId).map((a) => ({ id: a.user_id, displayName: a.display_name }));
      // Once the bot has left the channel (phase 'processing'), the live voice
      // roster is irrelevant — stick with the stored attendees.
      if (s.phase !== 'processing') {
        const channel = c?.guilds?.cache?.get(s.guildId)?.channels?.cache?.get(s.channelId);
        if (channel?.members) {
          // Prefer the live voice-channel roster (people who joined mid-meeting).
          const live = [...channel.members.values()].filter((m) => !m.user?.bot)
            .map((m) => ({ id: m.id, displayName: m.displayName }));
          if (live.length) attendees = live;
        }
      }
      return { ...s, attendees, progress: meetingProgress(s.meetingId) };
    });
  }

  r.get('/guilds', (_req, res) => {
    const c = liveClient();
    const fromDb = db.listGuilds().map(({ guild_id }) => guild_id);
    const fromCache = c ? [...c.guilds.cache.values()].map((g) => g.id) : [];
    const allIds = [...new Set([...fromDb, ...fromCache])];
    const dbNames = db.getGuildNames();
    res.json(allIds.map((id) => ({ id, name: guildName(c, id, dbNames) })));
  });

  // Newest first. ?limit=1..100 (default 100) and ?before=<meeting id> page back.
  r.get('/guilds/:g/meetings', (req, res) => {
    const limit = intQuery(req.query.limit, MEETING_PAGE_MAX, MEETING_PAGE_MAX);
    const before = intQuery(req.query.before, Number.MAX_SAFE_INTEGER, null);
    if (Number.isNaN(limit) || Number.isNaN(before)) {
      return res.status(400).json({ error: `limit must be 1-${MEETING_PAGE_MAX} and before a meeting id.` });
    }
    res.json(db.listRecentRich(req.params.g, limit, { before }));
  });

  // In-progress recordings for this guild, enriched with the channel's current
  // voice members (live attendees) when a Discord client is connected. The bot
  // holds active sessions in memory, so this is empty unless the bot is running.
  r.get('/guilds/:g/live', (req, res) => {
    res.json({ live: liveMeetings(req.params.g) });
  });

  // Stop a live recording from the dashboard. Finalizes the meeting (transcribe
  // + summarize + deliver) and disconnects the bot from the voice channel.
  r.post('/guilds/:g/live/:channelId/stop', async (req, res) => {
    if (!bot || typeof bot.stopMeeting !== 'function') {
      return res.status(400).json({ error: 'Live recording is not managed by this server.' });
    }
    try {
      const result = await bot.stopMeeting(req.params.g, req.params.channelId);
      if (!result.ok) return res.status(404).json(result);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dashboard aggregates — headline stats, talk-time leaderboard, timeline.
  r.get('/guilds/:g/stats', (req, res) => {
    res.json(db.statsBundle(req.params.g, 30));
  });

  // Meeting detail bundle: notes, transcript, this meeting's todos, the
  // adjacent meetings in the list, and what the retry/regenerate actions can do.
  r.get('/meetings/:id', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const utterances = db.listUtterances(id);
    const audioFiles = await readdir(audioDir(id)).catch(() => null);
    // The retry/regenerate planners re-read the meeting, its transcript and
    // its audio folder; hand them what this request already loaded instead.
    const loaded = { ...db, getMeeting: () => meeting, listUtterances: () => utterances };
    const listAudio = () => { if (!audioFiles) throw new Error('No audio folder.'); return audioFiles; };
    const plan = retryPlan(loaded, id, { dataDir: env.dataDir, exists: listAudio });
    const regen = regeneratePlan(loaded, id);
    const cfg = getGuildConfig(db, meeting.guild_id);
    const channelId = cfg.notesChannelId || meeting.channel_id;
    const channel = liveClient()?.channels?.cache?.get(channelId);
    res.json({
      meeting,
      summary: db.getSummary(id),
      attendees: db.listAttendees(id),
      utterances,
      todos: db.listMeetingTodos(id),
      neighbors: db.meetingNeighbors(meeting),
      retry: { eligible: !busyReason(meeting) && retryEligible(meeting, plan),
        action: plan.action, reason: plan.reason || null },
      progress: meetingProgress(id),
      deliveryTarget: channelId ? {
        id: channelId, name: channel?.name || (channelId === meeting.channel_id ? meeting.channel_name : null),
      } : null,
      regenerate: { eligible: regen.ok, reason: regen.reason || null, ...regeneration.get(id) },
      hasAudio: meeting.status === 'done' && !!meeting.audio_retained && audioFiles !== null,
    });
  });

  r.get('/meetings/:id/progress', (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    res.json({ progress: meetingProgress(id), status: meeting.status });
  });

  r.post('/meetings/:id/repost', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
    if (meeting.status !== 'done' || meetingProgress(id) || regeneration.get(id)?.state === 'running') {
      return res.status(409).json({ error: 'Wait for the meeting to finish processing.' });
    }
    const client = liveClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is disconnected.' });
    const cfg = getGuildConfig(db, meeting.guild_id);
    const result = await deliverSavedNotes(db, id, (notes, talktime) => postNotes({ client, meeting, cfg, notes, talktime }));
    if (result.conflict) return res.status(409).json({ error: 'A saved summary must be ready and delivery must be idle.' });
    if (!result.delivered) return res.status(502).json({ error: result.deliveryError });
    res.json({ ok: true });
  });

  r.get('/meetings/:id/audio', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (meeting?.status !== 'done' || !meeting.audio_retained) {
      return res.status(404).json({ error: 'No recording is available for this meeting.' });
    }
    const mp3 = join(audioDir(id), MP3_NAME);
    const isMp3 = existsSync(mp3);
    const file = isMp3 ? mp3 : await mixOnce(id);
    if (!file) return res.status(404).json({ error: 'No recording is available for this meeting.' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(file, `${meetingExportBasename(meeting)}.${isMp3 ? 'mp3' : 'wav'}`);
  });

  r.delete('/meetings/:id/audio', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (meeting?.status !== 'done') return res.status(404).json({ error: 'Completed meeting not found.' });
    const busy = busyReason(meeting);
    if (busy) return res.status(409).json({ error: busy });
    if (meeting.audio_retained) {
      await rm(audioDir(id), { recursive: true, force: true });
      db.setAudioRetained(id, false);
    }
    res.json({ ok: true });
  });

  // Shared snapshot and renderer for downloads and automatic local archives.
  r.get('/meetings/:id/export', (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const data = readMeetingExport(db, id);
    const basename = meetingExportBasename(meeting);
    if (req.query.format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${basename}.md"`);
      return res.send(renderMeetingMarkdown(data));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${basename}.json"`);
    res.json(data);
  });

  // Retry a failed/stuck meeting: re-summarize if the transcript survived, else
  // re-transcribe from the saved PCM. Posts to Discord too when a live client
  // is attached. Eligibility is checked up front; the work runs in the
  // background (202) and reports through GET /meetings/:id/progress, with the
  // outcome reflected in the meeting's status.
  r.post('/meetings/:id/retry', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const busy = busyReason(meeting);
    if (busy) return res.status(409).json({ error: busy });
    const plan = retryPlan(db, id, { dataDir: env.dataDir });
    if (!retryEligible(meeting, plan)) {
      return res.status(409).json({ error: plan.ok ? 'This meeting cannot be retried in its current state.' : plan.reason });
    }
    const c = liveClient();
    const deliver = c
      ? async (notes, talktime) => {
          const cfg = getGuildConfig(db, meeting.guild_id);
          await postNotes({ client: c, meeting: db.getMeeting(id), cfg, notes, talktime });
        }
      : null;
    // retryMeeting registers its progress synchronously, so a poll right after
    // this response already sees the retry running.
    retryMeeting(db, id, { dataDir: env.dataDir, deliver })
      .then((result) => { if (!result.ok) console.warn(`[retry] meeting ${id}: ${result.reason || 'retry failed'}`); })
      .catch((error) => console.error(`[retry] meeting ${id} failed:`, error));
    res.status(202).json({ ok: true, started: true });
  });

  // Regenerate a completed meeting's summary from its stored transcript with the
  // guild's current summarizer settings (e.g. after changing model or prompt).
  // On failure the existing notes are kept. Not re-posted to Discord.
  r.get('/meetings/:id/regenerate', (req, res) => {
    const id = Number(req.params.id);
    if (!db.getMeeting(id)) return res.status(404).json({ error: 'meeting not found' });
    res.json(regeneration.get(id) ?? { state: 'idle' });
  });

  r.post('/meetings/:id/regenerate', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const plan = regeneratePlan(db, id);
    if (!plan.meeting) return res.status(404).json({ error: 'meeting not found' });
    if (!plan.ok) return res.status(409).json({ error: plan.reason });
    const busy = busyReason(plan.meeting);
    if (busy) return res.status(409).json({ error: busy });
    regeneration.set(id, { state: 'running' });
    res.status(202).json({ state: 'running' });
    void regenerateSummary(db, id).then((result) => {
      regeneration.set(id, result.ok ? { state: 'done' } : { state: 'failed', error: result.reason });
    }).catch((error) => {
      console.error(`[summarizer] regeneration for meeting ${id} failed:`, error.message);
      regeneration.set(id, { state: 'failed', error: 'The new summary could not be saved.' });
    });
  });

  r.delete('/meetings/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const busy = busyReason(meeting);
    if (busy) return res.status(409).json({ error: busy });
    regeneration.delete(id);
    db.deleteMeeting(id);
    await removeMeetingArtifacts(meeting, artifactDirs());
    res.json({ ok: true });
  });

  // Summarize a merged meeting's combined transcript and swap in the new notes
  // (transactionally; action items that survive keep their done state).
  async function resummarizeMerged(target) {
    const utterances = db.listUtterances(target.id).map((u) => ({
      displayName: u.display_name, userId: u.user_id, text: u.text,
      startMs: u.start_ms, endMs: u.end_ms,
    }));
    const cfg = getGuildConfig(db, target.guild_id);
    const meta = {
      channelName: target.channel_name, date: target.started_at,
      attendees: db.listAttendees(target.id).map((a) => a.display_name),
      summaryLanguage: resolveSummaryLanguage(cfg),
      summaryPrompt: cfg.summaryPrompt,
      campaignContext: campaignContextFor(db, target),
    };
    const summarizer = getSummarizer(cfg);
    const notes = await summarizer.summarize(buildTranscript(utterances), meta);
    const modelUsed = summarizer.lastUsed ?? `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`;
    db.replaceSummary(target.id, target.guild_id, notes, computeTalkTime(utterances), modelUsed, target.started_at);
  }

  // Look up merge sources: an error { status, error } or { sources }.
  function mergeSources(target, rawIds) {
    const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(Number))]
      .filter((id) => Number.isSafeInteger(id) && id > 0 && id !== target.id);
    if (ids.length === 0) return { status: 400, error: 'sourceIds required' };
    const sources = ids.map((id) => db.getMeeting(id));
    const missing = ids.find((_, i) => !sources[i]);
    if (missing) return { status: 404, error: `meeting ${missing} not found` };
    if (sources.some((m) => m.guild_id !== target.guild_id)) return { status: 400, error: 'meetings belong to different guilds' };
    for (const m of [target, ...sources]) {
      const busy = busyReason(m);
      if (busy) return { status: 409, error: `Meeting ${m.id}: ${busy}` };
    }
    return { sources };
  }

  // Merge sourceIds into the target meeting, then re-summarize the combined
  // transcript. Sources must share the target's guild and be idle.
  r.post('/meetings/:id/merge', requireAdmin, async (req, res) => {
    const target = db.getMeeting(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'meeting not found' });
    const { sources, status, error } = mergeSources(target, req.body?.sourceIds);
    if (error) return res.status(status).json({ error });

    const merged = db.mergeMeetings(target.id, sources.map((m) => m.id));
    try {
      // Progress is registered before the first await, so the target can't be
      // deleted, retried or merged again while this runs.
      await withMeetingProgress(target.id, null, async () => {
        // The sources are gone from the db; drop their audio and transcript
        // exports (never throws), then re-summarize the combined transcript.
        await Promise.all(sources.map((m) => removeMeetingArtifacts(m, artifactDirs())));
        await resummarizeMerged(target);
      });
    } catch (e) {
      // Data is already merged; surface the summarize failure but don't unwind.
      await autoExportMeeting(db, target.id);
      return res.status(502).json({ error: e.message, merged });
    }
    await autoExportMeeting(db, target.id);
    res.json({ ok: true, merged });
  });

  r.get('/guilds/:g/todos', (req, res) => {
    const { open, assignee } = req.query;
    if (!isSingleQuery(open) || !isSingleQuery(assignee)) return res.status(400).json({ error: 'Repeat each filter at most once.' });
    const opts = { open: open === '1' };
    if (assignee !== undefined) opts.assignee = assignee === '__unassigned__' ? null : assignee;
    res.json(db.listTodos(req.params.g, opts));
  });

  r.get('/guilds/:g/assignees', (req, res) => {
    res.json(db.listAssignees(req.params.g));
  });

  r.patch('/todos/:id', requireAdmin, (req, res) => {
    if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done must be true or false.' });
    db.setTodoDone(Number(req.params.id), req.body.done);
    res.json({ ok: true });
  });

  r.get('/guilds/:g/search', (req, res) => {
    if (!isSingleQuery(req.query.q)) return res.status(400).json({ error: 'Send one search query.' });
    const q = (req.query.q || '').trim();
    res.json(q ? db.searchUtterances(req.params.g, q) : []);
  });

  r.get('/vocabulary', (_req, res) => res.json({ vocabulary: getVocabulary(db) }));
  r.put('/vocabulary', requireAdmin, (req, res) => {
    try {
      const vocabulary = setVocabulary(db, req.body?.text);
      res.json({ ok: true, vocabulary });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  r.get('/guilds/:g/speaker-names', requireAdmin, (req, res) => {
    const guildId = req.params.g;
    const members = liveClient()?.guilds?.cache?.get(guildId)?.members?.cache;
    const speakers = new Map(db.listGuildSpeakers(guildId).map((speaker) => [speaker.user_id, speaker]));
    for (const member of members?.values() ?? []) {
      if (!member.user.bot) {
        speakers.set(member.id, { user_id: member.id, display_name: member.displayName, override: speakers.get(member.id)?.override ?? null });
      }
    }
    res.json([...speakers.values()]);
  });

  r.put('/guilds/:g/speaker-names/:userId', requireAdmin, (req, res) => {
    const { g, userId } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : req.body?.name;
    if (!/^[1-9]\d{16,19}$/.test(userId) || !(name === null || (typeof name === 'string' && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name)))) {
      return res.status(400).json({ error: 'Enter a valid Discord user ID and a display name of up to 80 characters.' });
    }
    db.setSpeakerName(g, userId, name || null);
    res.json({ name: name || null });
  });

  r.get('/guilds/:g/config', (req, res) => {
    const guild = liveClient()?.guilds?.cache?.get(req.params.g);
    const channels = guild
      ? [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).values()]
          .map((c) => ({ id: c.id, name: c.name }))
      : [];
    const voiceChannels = guild
      ? [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).values()]
          .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }))
      : [];
    res.json({
      config: getGuildConfig(db, req.params.g),
      defaultSummaryPrompt: SUMMARY_PROMPT,
      defaultOverviewPrompt: DEFAULT_OVERVIEW_PROMPT,
      providers: availableProviders(env),
      sttProviders: availableSttProviders(env),
      channels,
      voiceChannels,
      defaultModels: DEFAULT_MODELS,
      secrets: secretStatus(env),
    });
  });

  // Apply a changed bot name in Discord right away. Best-effort: the setting is
  // saved either way, and a refusal (usually a missing Change Nickname
  // permission) is returned so the UI can say why the name didn't change.
  async function applyBotNickname(guildId) {
    if (typeof bot?.applyNickname !== 'function') return null;
    try {
      await bot.applyNickname(guildId);
      return null;
    } catch (e) {
      return e?.message || 'Discord refused the nickname change.';
    }
  }

  // Open to every user for everyday settings; ADMIN_CONFIG_FIELDS need an admin.
  r.patch('/guilds/:g/config', requireAdminForFields(ADMIN_CONFIG_FIELDS), async (req, res) => {
    const isKnown = db.isKnownGuild(req.params.g) || !!liveClient()?.guilds?.cache?.has?.(req.params.g);
    if (!isKnown) return res.status(404).json({ error: 'Unknown server.' });
    const input = req.body ?? {};
    const inputError = configInputError(input);
    if (inputError) return res.status(400).json({ error: inputError });
    // Validate against the guild's stored settings (e.g. a bare sttModel must
    // suit the provider already saved, not one the client claims).
    const result = validateSetup(input, env, getGuildConfig(db, req.params.g));
    if (!result.ok) return res.status(400).json({ error: result.error });
    const config = setGuildConfig(db, req.params.g, result.patch);
    // Follow the transcription backend with the local sidecar process: start it
    // when a guild switches to the sidecar, and stop it when no guild needs it
    // anymore (switched everything to a cloud API). Best-effort, non-blocking.
    let sidecarStatus = sidecar ? sidecar.status() : null;
    if (sidecar && sidecar.managed() && result.patch.sttProvider !== undefined) {
      try {
        if (result.patch.sttProvider === 'sidecar') {
          await sidecar.start();
        } else if (!anyGuildUsesSidecar(db)) {
          await sidecar.stop();
        }
        sidecarStatus = sidecar.status();
      } catch { /* surface via status only */ }
    }
    const nicknameError = result.patch.botNickname !== undefined ? await applyBotNickname(req.params.g) : null;
    res.json({ ok: true, config, sidecar: sidecarStatus, nicknameError });
  });

  // Full model catalog for a provider, queried live (Gemini ListModels, the
  // OpenAI-compatible /models endpoints, Ollama's installed tags) and cached.
  // `?refresh=1` bypasses the cache for admins (others get the cached catalog,
  // so they can't make Parley hammer provider APIs). Degrades to the curated
  // shortlist when the provider can't be reached — see adapters/summarizer/models.js.
  r.get('/providers/:provider/models', async (req, res) => {
    const { provider } = req.params;
    if (!CATALOG_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Unknown provider "${provider}". Use one of: ${CATALOG_PROVIDERS.join(', ')}.` });
    }
    res.json(await listModels(provider, { env, refresh: req.query.refresh === '1' && isAdminRequest(req) }));
  });

  // Set or clear a provider's API key. Persists to .env and updates the live
  // config so it takes effect immediately. Never returns the key value.
  r.put('/providers/:provider/key', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!isSecretProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider}" has no editable API key.` });
    }
    const value = typeof req.body?.key === 'string' ? req.body.key : '';
    try {
      const secrets = await setProviderKey(provider, value, { env });
      // A new key turns a "curated fallback" catalog into a live one; drop the
      // cached miss so the picker fills immediately.
      clearModelCache(provider);
      res.json({ ok: true, secrets, providers: availableProviders(env) });
    } catch (e) {
      // Validation failures (control chars in the key) are the client's fault.
      res.status(400).json({ error: e.message });
    }
  });

  // ── System / connection ─────────────────────────────────────────────────
  // The slash-command reference for the dashboard's Commands page.
  r.get('/commands', (_req, res) => {
    res.json({ commands: COMMAND_CATALOG });
  });

  r.post('/system/prune', requireAdmin, async (req, res) => {
    try {
      res.json(await pruneMeetings(db, req.body?.days, { dryRun: req.body?.confirm !== true }));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });

  // Overall onboarding + bot connection state for the UI. Never leaks secrets.
  r.get('/system/status', (_req, res) => {
    const c = liveClient();
    res.json({
      connection: connectionStatus(env),
      providers: availableProviders(env),
      sttProviders: availableSttProviders(env),
      secrets: secretStatus(env),
      bot: bot
        ? bot.status()
        // No controller (standalone server): report live client if present.
        : { state: c ? 'ready' : 'stopped', connected: !!c, hasCreds: !!env.discordToken,
            user: c?.user ? { tag: c.user.tag, id: c.user.id } : null, guildCount: c?.guilds?.cache?.size ?? 0 },
      managed: !!bot,
      sttUrl: redactUrl(env.sttUrl),
      sidecar: sidecar ? sidecar.status() : null,
    });
  });

  // Save connection settings (any subset), persist to .env,
  // apply live, and (re)start the bot if it's managed and creds are present.
  r.put('/system/connection', requireAdmin, async (req, res) => {
    const patch = {};
    for (const k of ['discordToken', 'discordClientId', 'sttUrl', 'ollamaUrl']) {
      if (typeof req.body?.[k] === 'string') patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No recognized settings to update.' });
    let connection;
    try {
      connection = await setConnection(patch, { env });
      if (patch.ollamaUrl !== undefined) clearModelCache('ollama');
    } catch (e) {
      // Invalid input (bad STT URL, control chars) → 400, not a server error.
      return res.status(400).json({ error: e.message });
    }
    try {
      let botResult = null;
      // Restart the bot when Discord creds changed and we manage it.
      if (bot && (patch.discordToken !== undefined || patch.discordClientId !== undefined)) {
        botResult = await bot.restart();
      }
      res.json({ ok: true, connection, bot: bot ? bot.status() : null, botResult });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manually (re)start or stop the bot.
  r.post('/system/bot/:action', requireAdmin, async (req, res) => {
    if (!bot) return res.status(400).json({ error: 'Bot is not managed by this server.' });
    const { action } = req.params;
    try {
      if (action === 'start') await bot.start();
      else if (action === 'restart') await bot.restart();
      else if (action === 'stop') await bot.stop();
      else return res.status(400).json({ error: `Unknown action "${action}".` });
      res.json({ ok: true, bot: bot.status() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start/stop/restart the local STT sidecar process from the dashboard. The
  // sidecar is a single global process (transcription backend), so this is not
  // per-guild. Unmanaged in Docker (separate container) — report that clearly.
  r.post('/system/sidecar/:action', requireAdmin, async (req, res) => {
    if (!sidecar) return res.status(400).json({ error: 'Sidecar is not managed by this server.' });
    const { action } = req.params;
    if (!sidecar.managed() && action !== 'status') {
      return res.status(400).json({ error: sidecar.status().error || 'Local sidecar is not manageable here (running in Docker or STT_URL is remote).', sidecar: sidecar.status() });
    }
    try {
      let result = { ok: true };
      if (action === 'start') result = await sidecar.start();
      else if (action === 'restart') result = await sidecar.restart();
      else if (action === 'stop') result = await sidecar.stop();
      else if (action !== 'status') return res.status(400).json({ error: `Unknown action "${action}".` });
      const status = sidecar.status();
      if (!result.ok) return res.status(502).json({ error: result.error || 'Sidecar action failed.', sidecar: status });
      res.json({ ok: true, sidecar: status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/guilds/:g/meetings/:id/ask', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const question = questionOf(req.body);
    if (!question) return res.status(400).json({ error: 'question required' });
    const transcript = db.listUtterances(id).map((u) => `${u.display_name}: ${u.text}`).join('\n');
    try {
      const answer = await askMeeting({
        cfg: getGuildConfig(db, meeting.guild_id), env, question, transcript,
        meta: { channelName: meeting.channel_name, date: meeting.started_at,
          attendees: db.listAttendees(id).map((a) => a.display_name) },
      });
      res.json({ answer });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  mountCampaignRoutes(r, { db, liveClient });

  return r;
}
