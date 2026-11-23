// Per-guild voice bookkeeping for the bot: which channel is mid-join, stops that
// arrive during that join window, recent join failures (so auto-join doesn't
// retry in a tight loop) and auto-leave grace timers. Timers and clock are
// injectable so every rule here is unit-testable without Discord.

// A participant's brief drop (mobile reconnect, network blip) must not split one
// session into several meetings, each with its own STT + LLM run and post.
export const AUTO_LEAVE_GRACE_MS = 25_000;
// After a failed join/start, auto-join leaves that channel alone for a while.
export const JOIN_FAILURE_BACKOFF_MS = 60_000;

export class GuildVoiceGate {
  constructor({
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    graceMs = AUTO_LEAVE_GRACE_MS, backoffMs = JOIN_FAILURE_BACKOFF_MS, log = console,
  } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, graceMs, backoffMs, log });
    this.joining = new Map();     // guildId -> { channelId, cancelled }
    this.leaving = new Map();     // guildId -> number of stops still flushing
    this.failures = new Map();    // "guild:channel" -> failedAt (ms)
    this.leaveTimers = new Map(); // guildId -> { channelId, timer }
  }

  tryBeginJoin(guildId, channelId) {
    if (this.joining.has(guildId)) return false;
    this.joining.set(guildId, { channelId, cancelled: false });
    return true;
  }

  joiningChannel(guildId) { return this.joining.get(guildId)?.channelId ?? null; }
  isCancelled(guildId) { return !!this.joining.get(guildId)?.cancelled; }
  endJoin(guildId) { this.joining.delete(guildId); }

  /** A stop (/leave, dashboard) that lands while `channelId` is still joining. */
  requestCancel(guildId, channelId) {
    const join = this.joining.get(guildId);
    if (!join || join.channelId !== channelId) return false;
    this.joining.set(guildId, { ...join, cancelled: true });
    return true;
  }

  // A stop is flushing capture and still holds the guild's one voice
  // connection: a join now would reuse that connection and lose it moments
  // later when the stop destroys it. Counted, since stops can overlap.
  beginLeave(guildId) { this.leaving.set(guildId, (this.leaving.get(guildId) ?? 0) + 1); }
  endLeave(guildId) {
    const left = (this.leaving.get(guildId) ?? 1) - 1;
    if (left > 0) this.leaving.set(guildId, left);
    else this.leaving.delete(guildId);
  }
  isLeaving(guildId) { return this.leaving.has(guildId); }

  recordFailure(guildId, channelId) { this.failures.set(`${guildId}:${channelId}`, this.now()); }
  clearFailure(guildId, channelId) { this.failures.delete(`${guildId}:${channelId}`); }

  inBackoff(guildId, channelId) {
    const key = `${guildId}:${channelId}`;
    const failedAt = this.failures.get(key);
    if (failedAt === undefined) return false;
    if (this.now() - failedAt < this.backoffMs) return true;
    this.failures.delete(key);
    return false;
  }

  /** Run `onExpire` after the grace period unless cancelLeave() comes first. */
  scheduleLeave(guildId, channelId, onExpire) {
    if (this.leaveTimers.has(guildId)) return false;
    const timer = this.setTimer(() => {
      this.leaveTimers.delete(guildId);
      // A timer callback has no caller to reject to: contain every failure.
      Promise.resolve().then(onExpire).catch((err) => {
        this.log.error(`[voice] auto-leave for guild ${guildId} failed: ${err?.message ?? err}`);
      });
    }, this.graceMs);
    timer?.unref?.();
    this.leaveTimers.set(guildId, { channelId, timer });
    return true;
  }

  pendingLeave(guildId) { return this.leaveTimers.get(guildId)?.channelId ?? null; }

  cancelLeave(guildId) {
    const pending = this.leaveTimers.get(guildId);
    if (!pending) return false;
    this.clearTimer(pending.timer);
    this.leaveTimers.delete(guildId);
    return true;
  }

  clear() {
    for (const guildId of [...this.leaveTimers.keys()]) this.cancelLeave(guildId);
    this.joining.clear();
    this.failures.clear();
  }
}
