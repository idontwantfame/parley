// src/web/regeneration-state.js
// The dashboard's per-meeting summary-regeneration status ('running', then
// 'done' or 'failed' with an error). A finished result only needs to outlive
// the page that started it, so it expires; the map is also capped, so it
// can't grow for the lifetime of the process. Running entries never expire.

export const FINISHED_TTL_MS = 10 * 60 * 1000;
export const MAX_ENTRIES = 500;

const view = ({ finishedAt: _finishedAt, ...entry }) => entry;

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
      return entry ? view(entry) : undefined;
    },
    isRunning: (id) => entries.get(id)?.state === 'running',
    start: (id) => put(id, { state: 'running' }),
    finish: (id, result) => put(id, { ...result, finishedAt: now() }),
    delete: (id) => entries.delete(id),
    size: () => entries.size,
  };
}
