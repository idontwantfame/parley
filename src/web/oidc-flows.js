// src/web/oidc-flows.js
// Server-side state for SSO logins in progress, the returnTo guard, and a
// per-client limiter for starting logins.
//
// /api/auth/oidc/login stores { state, nonce, PKCE verifier, returnTo } under a
// random flow id and puts only that id in a short-lived cookie; the callback
// takes (and thereby deletes) the entry once its state matches. Binding the
// flow to the browser's cookie stops login CSRF, and single use stops replay.
// Memory is bounded: a TTL, a per-owner (client IP) cap so one client can only
// evict its own flows, and a global cap that evicts the oldest flow first.

import { randomBytes } from 'node:crypto';

export const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_MAX_ENTRIES = 1000;
const FLOW_MAX_PER_OWNER = 10;
const FLOW_ID_BYTES = 32;

export function createFlowStore({
  now = () => Date.now(), ttlMs = FLOW_TTL_MS, maxEntries = FLOW_MAX_ENTRIES, maxPerOwner = FLOW_MAX_PER_OWNER,
} = {}) {
  const entries = new Map(); // id -> { data, owner, expiresAt }, oldest first

  // Same TTL for every entry, so insertion order is expiry order: sweep from
  // the front, then drop the oldest live flow if still at capacity.
  function evict(t) {
    for (const [id, entry] of entries) {
      if (entry.expiresAt > t && entries.size < maxEntries) break;
      entries.delete(id);
    }
  }

  // At the owner's cap, its own oldest flow makes room (never someone else's).
  function evictOwn(owner) {
    const own = [...entries].filter(([, e]) => e.owner === owner);
    for (const [id] of own.slice(0, Math.max(0, own.length - maxPerOwner + 1))) entries.delete(id);
  }

  return {
    put(data, owner = '') {
      const t = now();
      evict(t);
      evictOwn(owner);
      const id = randomBytes(FLOW_ID_BYTES).toString('base64url');
      entries.set(id, { data, owner, expiresAt: t + ttlMs });
      return id;
    },
    // Returns the flow's data once (deleting it), or null when unknown/expired/
    // used. With `accept`, a flow it rejects is left in place untouched.
    take(id, accept = () => true) {
      if (typeof id !== 'string' || !id) return null;
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { entries.delete(id); return null; }
      if (!accept(entry.data)) return null;
      entries.delete(id);
      return entry.data;
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Fixed-window counter per key (client IP): at most `limit` hits per window.
 * Bounded memory: stale windows and, at capacity, the oldest keys are dropped.
 */
export function createFixedWindowLimiter({ limit, windowMs, now = () => Date.now(), maxKeys = 10_000 }) {
  const windows = new Map(); // key -> { start, count }, oldest window first

  function evict(t) {
    for (const [key, w] of windows) {
      if (t - w.start < windowMs && windows.size < maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    hit(key) {
      const t = now();
      const current = windows.get(key);
      if (current && t - current.start < windowMs) {
        const count = current.count + 1;
        windows.set(key, { start: current.start, count }); // same key keeps its place in the order
        return count <= limit;
      }
      windows.delete(key);
      evict(t);
      windows.set(key, { start: t, count: 1 });
      return 1 <= limit;
    },
    retryAfterSec(key) {
      const w = windows.get(key);
      return w ? Math.max(1, Math.ceil((w.start + windowMs - now()) / 1000)) : 0;
    },
    size() {
      return windows.size;
    },
  };
}

const MAX_RETURN_TO = 2048;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const PROBE_ORIGIN = 'http://parley.invalid';

function decodesToControlChars(value) {
  try { return CONTROL_CHARS.test(decodeURIComponent(value)); } catch { return true; }
}

/**
 * A same-origin relative path to send the browser to after sign-in, or "/".
 * Rejects absolute URLs, protocol-relative "//host", backslash tricks ("/\host"
 * is "//host" to browsers) and control characters (browsers strip tabs and
 * newlines, so "/\t/host" would also become "//host").
 */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > MAX_RETURN_TO) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (CONTROL_CHARS.test(value) || decodesToControlChars(value)) return '/';
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return '/';
  } catch { return '/'; }
  return value;
}
