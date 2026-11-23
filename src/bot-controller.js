// src/bot-controller.js
// Owns the Discord bot lifecycle so the web UI can start/restart it on demand.
// The web server boots first and always; the bot starts only when credentials
// exist (either from the environment at boot, or saved later via the UI).
import { startBot as defaultStartBot } from './bot.js';
import { hasDiscordCreds } from './config/env.js';

// stop()/restart() wait this long for in-flight pipelines (transcribe →
// summarize → post) before destroying the client they deliver notes through.
export const FINALIZE_DRAIN_MS = 3 * 60_000;

export class BotController {
  constructor({ db, audioRoot, startBot = defaultStartBot, hasCreds = hasDiscordCreds, log = console }) {
    this.db = db;
    this.audioRoot = audioRoot;
    this.startBotImpl = startBot;
    this.hasCreds = hasCreds;
    this.log = log;
    this.bot = null;            // what startBot() returned
    this.client = null;
    this.manager = null;
    this.stopAndLeave = null;
    this.detach = null;         // removes this controller's listeners from the client
    this.stopping = null;       // in-flight stop() promise
    this.state = 'stopped';     // 'stopped' | 'starting' | 'ready' | 'error' | 'stopping'
    this.error = null;
  }

  isRunning() {
    return this.state === 'starting' || this.state === 'ready';
  }

  /** Start the bot if creds exist and it isn't already running. Idempotent. */
  async start() {
    // Never overlap two logged-in clients: let a running stop() finish first.
    if (this.stopping) await this.stopping;
    if (this.isRunning()) return { ok: true, state: this.state };
    if (!this.hasCreds()) {
      this.state = 'stopped';
      this.error = 'Discord credentials are not set.';
      return { ok: false, error: this.error };
    }
    this.state = 'starting';
    this.error = null;
    try {
      this.attach(this.startBotImpl({ db: this.db, audioRoot: this.audioRoot }));
      return { ok: true, state: this.state };
    } catch (e) {
      this.state = 'error';
      this.error = e.message;
      return { ok: false, error: e.message };
    }
  }

  attach(bot) {
    const { client } = bot;
    Object.assign(this, { bot, client, manager: bot.manager, stopAndLeave: bot.stopAndLeave });
    // Events from a client we've since replaced (e.g. its login rejecting after
    // a restart) must not touch the current state.
    const onReady = () => { if (this.client === client) { this.state = 'ready'; this.error = null; } };
    // A connection/login error (including a rejected login re-emitted by
    // bot.js) marks the controller errored so the UI stops showing 'ready'.
    const onError = (e) => { if (this.client === client) { this.state = 'error'; this.error = e.message; } };
    client.once('clientReady', onReady);
    client.on('error', onError);
    this.detach = () => {
      client.off('clientReady', onReady);
      client.off('error', onError);
    };
  }

  /** Tear down the live client. Single-flight; see _stop. */
  stop(options) {
    if (!this.stopping) this.stopping = this._stop(options).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  // Stop taking new recordings, flush the live ones so their pipelines run, and
  // wait (bounded) for those pipelines: they post notes through this client, so
  // destroying it first would make every delivery — and its failure notice — fail.
  async _stop({ drainTimeoutMs = FINALIZE_DRAIN_MS } = {}) {
    const { bot, manager, client } = this;
    if (bot) {
      this.state = 'stopping';
      bot.quiesce?.();
      await Promise.all(manager.listActive().map((s) =>
        this.stopMeeting(s.guildId, s.channelId).catch((e) => this.log.error(`[bot] stopping meeting ${s.meetingId} failed: ${e.message}`))
      ));
      const { timedOut, pending } = await manager.waitForFinalize(drainTimeoutMs);
      if (timedOut) {
        this.log.warn(`[bot] ${pending} meeting pipeline(s) still running after ${Math.round(drainTimeoutMs / 1000)}s; stopping anyway — they can be retried from the dashboard.`);
      }
      this.detach?.();
      try { await client.destroy(); } catch { /* ignore */ }
    }
    Object.assign(this, { bot: null, client: null, manager: null, stopAndLeave: null, detach: null });
    this.state = 'stopped';
  }

  /** Live sessions for the web dashboard: recordings plus post-recording pipelines. */
  liveMeetings() {
    if (!this.manager) return [];
    return [
      ...this.manager.listActive().map((s) => ({ ...s, phase: 'recording' })),
      ...this.manager.listProcessing().map((s) => ({ ...s, phase: 'processing' })),
    ];
  }

  /** Stop a live recording in a channel from the dashboard. Best-effort. */
  async stopMeeting(guildId, channelId) {
    if (!this.manager) throw new Error('Bot is not running.');
    if (!this.manager.isActive(guildId, channelId)) {
      // Still joining (up to ~25 s): cancel it so it doesn't start afterwards.
      if (this.bot?.cancelJoin?.(guildId, channelId)) return { ok: true, cancelled: true };
      return { ok: false, error: 'No active recording in that channel.' };
    }
    // stopAndLeave stops capture and disconnects the voice client. It resolves
    // as soon as the capture is flushed — the transcribe/summarize pipeline
    // continues in the background (visible via phase 'processing').
    if (this.stopAndLeave) await this.stopAndLeave(guildId, channelId);
    else await this.manager.stop(guildId, channelId);
    return { ok: true };
  }

  /**
   * Apply a guild's bot name (nickname) now, e.g. after it changed in Settings.
   * Resolves false when the bot isn't connected (it applies configured names
   * when it connects); rejects if Discord refuses the change.
   */
  async applyNickname(guildId) {
    if (!this.bot?.applyNickname || this.state !== 'ready') return false;
    await this.bot.applyNickname(guildId);
    return true;
  }

  /** Stop then start — used after credentials change in the UI. */
  async restart() {
    await this.stop();
    return this.start();
  }

  /** Snapshot for the web UI. */
  status() {
    return {
      state: this.state,
      error: this.error,
      connected: this.state === 'ready',
      hasCreds: this.hasCreds(),
      user: this.client?.user ? { tag: this.client.user.tag, id: this.client.user.id } : null,
      guildCount: this.client?.guilds?.cache?.size ?? 0,
    };
  }
}

// Docker sends SIGTERM and SIGKILLs 10 s later. Capture flushes in well under a
// second; pipelines get a few seconds and anything unfinished stays
// 'processing', which the next boot's reconcile turns into a retryable meeting.
export const SHUTDOWN_DRAIN_MS = 4_000;
export const SHUTDOWN_LIMIT_MS = 8_000;

/** SIGTERM/SIGINT handler: stop bot → sidecar → web server, then exit. */
export function createShutdown({
  bot, sidecar, closeServer, exit = (code) => process.exit(code), log = console,
  drainMs = SHUTDOWN_DRAIN_MS, limitMs = SHUTDOWN_LIMIT_MS,
}) {
  let inProgress = false;
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { log.error(`[shutdown] ${name} failed: ${e.message}`); }
  };
  return async function shutdown(signal) {
    if (inProgress) {
      log.warn(`[shutdown] ${signal} again — forcing exit.`);
      exit(1);
      return;
    }
    inProgress = true;
    log.log(`[shutdown] ${signal}: finishing recordings and stopping services…`);
    const limit = setTimeout(() => {
      log.warn(`[shutdown] still busy after ${limitMs / 1000}s — exiting; unfinished meetings can be retried after restart.`);
      exit(1);
    }, limitMs);
    await step('bot', () => bot?.stop({ drainTimeoutMs: drainMs }));
    await step('sidecar', () => sidecar?.stop());
    await step('web server', () => closeServer?.());
    clearTimeout(limit);
    exit(0);
  };
}
