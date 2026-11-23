// src/web/regeneration-state.js
// The dashboard's per-meeting summary-regeneration status ('running', then
// 'done' or 'failed' with an error). A finished result only needs to outlive
// the page that started it, so it expires; the map is also capped, so it
// can't grow for the lifetime of the process. Running entries never expire.

export const FINISHED_TTL_MS = 10 * 60 * 1000;
export const MAX_ENTRIES = 500;

const view = ({ finishedAt: _finishedAt, ...entry }) => entry;
const average = (durations) => durations.length
  ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
  : 0;

function progressView(progress, now) {
  const { stage, total, overviewTotal, chunkDurationsMs, overviewDurationsMs, stepStartedAt } = progress;
  const chunkAverage = average(chunkDurationsMs);
  const overviewAverage = average(overviewDurationsMs) || chunkAverage;
  const stepsLeft = stage === 'chunks' ? total - chunkDurationsMs.length : overviewTotal - overviewDurationsMs.length;
  const stepAverage = stage === 'chunks' ? chunkAverage : overviewAverage;
  const overviewTime = stage === 'chunks' ? overviewTotal * overviewAverage : 0;
  const elapsed = Math.max(0, now - stepStartedAt);
  const remainingMs = stepsLeft > 0 && stepAverage > 0
    ? Math.round(overviewTime + (stepsLeft - 1) * stepAverage + Math.max(0, stepAverage - elapsed))
    : 0;
  return {
    stage, total, overviewTotal, chunkDurationsMs: [...chunkDurationsMs],
    completed: chunkDurationsMs.length, overviewCompleted: overviewDurationsMs.length,
    remainingMs: remainingMs || null,
    estimatedFinishAt: remainingMs ? now + remainingMs : null,
  };
}

export function createRegenerationState({ now = Date.now, ttlMs = FINISHED_TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
  const entries = new Map(); // meeting id -> { state, error?, finishedAt? } (oldest first)

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.finishedAt !== undefined && entry.finishedAt <= cutoff) entries.delete(id);
    }
    for (const [id, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.finishedAt !== undefined) entries.delete(id);
    }
  }

  // Re-insert so the Map's order stays oldest-first.
  function put(id, entry) {
    entries.delete(id);
    entries.set(id, entry);
    prune();
  }

  return {
    get(id) {
      prune();
      const entry = entries.get(id);
      if (entry?.progress) return { state: entry.state, progress: progressView(entry.progress, now()) };
      return entry ? view(entry) : undefined;
    },
    isRunning: (id) => entries.get(id)?.state === 'running',
    start: (id) => put(id, { state: 'running' }),
    update(id, event) {
      const entry = entries.get(id);
      if (entry?.state !== 'running') return;
      if (event.stage === 'fallback') {
        delete entry.progress;
      } else if (event.stage === 'chunks') {
        entry.progress = {
          stage: 'chunks', total: event.total, overviewTotal: event.overviewTotal,
          chunkDurationsMs: [], overviewDurationsMs: [], stepStartedAt: now(),
        };
      } else if (entry.progress) {
        const progress = entry.progress;
        if (event.stage === 'overview') {
          progress.stage = 'overview';
          progress.overviewTotal = event.total;
        } else {
          const durations = progress.stage === 'chunks' ? progress.chunkDurationsMs : progress.overviewDurationsMs;
          durations.push(event.durationMs);
        }
        progress.stepStartedAt = now();
      }
    },
    finish: (id, result) => put(id, { ...result, finishedAt: now() }),
    delete: (id) => entries.delete(id),
    size: () => entries.size,
  };
}
