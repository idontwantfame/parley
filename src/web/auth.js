// src/web/auth.js
// Session-cookie auth for the dashboard API. Dependency-free: a single httpOnly
// cookie carries an opaque session token resolved server-side against the
// `sessions` table (see src/store/users.js).
//
//   • requireAuth(users)        — Express middleware; 401s unauthenticated calls
//   • authRouter({ users })     — /api/auth/* (login, logout, me, password) +
//                                  /api/users (admin CRUD)
//
// The web server binds localhost by default, but auth makes the dashboard safe
// to expose (e.g. behind a reverse proxy / Docker port map).

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { USERNAME_MAX } from '../store/users.js';

const COOKIE = 'parley_session';
// Minimum password length, enforced on every set/change/reset path. Kept modest
// for a self-hosted tool but well above the old 4-char floor.
export const PASSWORD_MIN = 8;

// Minimal cookie parser — we only need our one session cookie, so no dep.
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    // A malformed escape is a bad cookie, not a server error: treat as absent.
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
  }
  return null;
}

function setSessionCookie(res, token, expiresAt, secure) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  // Secure only over https (so localhost http dev still works). Express sets
  // req.secure from the connection / X-Forwarded-Proto when trust proxy is on.
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res, secure) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(0).toUTCString()}`];
  if (secure) attrs.push('Secure'); // mirror setSessionCookie so browsers match the cookie
  res.append('Set-Cookie', attrs.join('; '));
}

// In-memory login rate limiter — no dep, resets on process restart (fine: its
// job is to blunt online brute force, not to be a durable audit log). Keyed by
// caller-provided string (we use ip + lowercased username). After `maxFailures`
// consecutive failures the key locks out for `lockoutMs`, doubling on each
// subsequent lockout up to `maxLockoutMs`. A success (or going quiet for
// `maxLockoutMs`) clears the slate. `now` is injectable for tests.
//
// Memory is bounded: keys are stored as fixed-size digests, the map holds at
// most `maxEntries` keys, and it is kept in last-failure order so stale keys
// (and, at capacity, the oldest) are dropped from the front in O(1) amortized.
export function createLoginLimiter({
  now = () => Date.now(),
  maxFailures = 5,
  lockoutMs = 30_000,
  maxLockoutMs = 15 * 60_000,
  maxEntries = 10_000,
} = {}) {
  const entries = new Map(); // digest -> { failures, strikes, lockedUntil, lastFailAt }, oldest failure first
  const digest = (key) => createHash('sha256').update(String(key)).digest('base64url');

  // Drop keys quiet long enough to be forgiven anyway, then (at capacity) the
  // oldest, leaving room for one insert.
  function evict(t) {
    for (const [key, e] of entries) {
      if (t - e.lastFailAt <= maxLockoutMs && entries.size < maxEntries) break;
      entries.delete(key);
    }
  }

  function nextEntry(prev, t) {
    // Stale entries (quiet past the max lockout) start fresh — old failures
    // shouldn't haunt a user forever.
    const base = !prev || t - prev.lastFailAt > maxLockoutMs ? { failures: 0, strikes: 0, lockedUntil: 0 } : prev;
    const failures = base.failures + 1;
    if (failures < maxFailures) return { ...base, failures, lastFailAt: t };
    const strikes = base.strikes + 1; // exponential backoff per completed lockout cycle
    return { failures: 0, strikes, lastFailAt: t,
      lockedUntil: t + Math.min(lockoutMs * 2 ** (strikes - 1), maxLockoutMs) };
  }

  return {
    // null when allowed, otherwise seconds until the lockout lifts.
    retryAfterSec(key) {
      const e = entries.get(digest(key));
      if (!e || e.lockedUntil <= now()) return null;
      return Math.ceil((e.lockedUntil - now()) / 1000);
    },
    fail(key) {
      const k = digest(key);
      const t = now();
      const prev = entries.get(k);
      entries.delete(k); // re-inserted at the back: the map stays in failure order
      evict(t);
      entries.set(k, nextEntry(prev, t));
    },
    reset(key) {
      entries.delete(digest(key));
    },
    size() {
      return entries.size;
    },
  };
}

// Attaches req.user (or null) from the session cookie. Use before requireAuth
// so optional routes can read the user too.
export function attachUser(users) {
  return (req, _res, next) => {
    const token = readCookie(req, COOKIE);
    req.sessionToken = token ?? null;
    req.authResolved = true; // marks that the auth stack ran (see requireAdmin)
    req.user = token ? users.getSessionUser(token) : null;
    next();
  };
}

export function requireAuth(_users) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    next();
  };
}

// Gates a route to admin users only. When the auth stack ran (attachUser set
// req.authResolved) a missing or non-admin user is rejected — fail closed. Only
// when auth was never wired in front (the standalone/test server that mounts
// apiRouter bare) is it permissive, since there's no auth to enforce there.
export function isAdminRequest(req) {
  return !req.authResolved || !!req.user?.isAdmin;
}

export function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Blocks the data/system API while the logged-in account still uses its seeded
// default password (must_change_password). Auth routes (login/logout/me/password)
// are mounted *before* this, so the user can still authenticate and set a real
// password — they just can't touch anything else until they do. Without this, a
// reachable instance with the default admin/admin is fully operable by anyone.
export function requirePasswordChanged(_users) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.mustChangePassword) {
      return res.status(403).json({
        error: 'Set a new password before using the dashboard.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    next();
  };
}

// Same-origin guard for state-changing requests: browsers always attach an
// Origin header on cross-site POST/PUT/PATCH/DELETE, so rejecting a mismatched
// Origin blocks CSRF without tokens. Requests with no Origin (same-origin GETs,
// non-browser API clients, tests) are allowed — they can't be CSRF vectors.
// The comparison uses req.host, which honours X-Forwarded-Host only when the
// `trust proxy` setting trusts the hop (TRUSTED_PROXY), so a reverse proxy that
// rewrites Host still passes while a direct client cannot spoof it.
export function sameOrigin(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: 'Bad Origin.' }); }
  if (originHost !== req.host) {
    return res.status(403).json({ error: 'Cross-origin request refused.' });
  }
  next();
}

export function authRouter({ users, now = () => Date.now(), loginLimiter = createLoginLimiter({ now }) }) {
  const r = Router();

  // ── Session ────────────────────────────────────────────────────────────────
  r.post('/auth/login', async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    // No account can have a longer name; refuse before it reaches the limiter.
    if (username.length > USERNAME_MAX) return res.status(400).json({ error: 'Invalid username or password.' });
    // Rate-limit per (ip, username) so one attacker can't lock everyone out and
    // a distributed guess against one account still trips per-IP keys.
    const limitKey = `${req.ip ?? ''}|${username.toLowerCase()}`;
    const retryAfter = loginLimiter.retryAfterSec(limitKey);
    if (retryAfter !== null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many failed login attempts. Try again in ${retryAfter}s.` });
    }
    // Count the attempt before the (async) password check so parallel guesses
    // can't all pass the check above; a correct password clears it again.
    loginLimiter.fail(limitKey);
    const user = await users.authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    loginLimiter.reset(limitKey);
    const { token, expiresAt } = users.createSession(user.id);
    setSessionCookie(res, token, expiresAt, req.secure);
    res.json({ ok: true, user });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.sessionToken) users.deleteSession(req.sessionToken);
    clearSessionCookie(res, req.secure);
    res.json({ ok: true });
  });

  // Current user (or null). Drives the frontend's auth gate; never 401s.
  // `authEnabled: true` tells the client this server enforces login (older
  // servers without this route make the client fall back to open mode).
  // `defaultPasswordActive` lets the login screen show the admin/admin hint only
  // while it's actually true, instead of advertising it to every visitor.
  r.get('/auth/me', (req, res) => {
    res.json({
      authEnabled: true,
      user: req.user || null,
      defaultPasswordActive: users.defaultPasswordActive ? users.defaultPasswordActive() : undefined,
    });
  });

  // Change your own password. Requires the current password unless the account
  // is flagged must_change_password (the seeded default admin's first change).
  // On success every other session for this user is revoked (a password change
  // is the response to a suspected compromise) and the current request gets a
  // fresh session cookie so the user stays logged in here.
  r.post('/auth/password', requireAuth(users), async (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    if (next.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters.` });
    }
    const row = users.getUserByUsername(req.user.username);
    const mustChange = !!row?.must_change_password;
    if (!mustChange) {
      if (!(await users.authenticate(req.user.username, current))) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    }
    users.setPassword(req.user.id, next);
    users.deleteUserSessions(req.user.id); // revoke all sessions, including this one
    const { token, expiresAt } = users.createSession(req.user.id); // re-issue for the current request
    setSessionCookie(res, token, expiresAt, req.secure);
    res.json({ ok: true, user: users.getUser(req.user.id) });
  });

  // ── User management (admin) ─────────────────────────────────────────────────
  // Gated like the rest of the API: an account still on the seeded default
  // password must change it before it can create or promote anyone.
  const adminOnly = [requireAuth(users), requirePasswordChanged(users), requireAdmin];
  const badIsAdmin = (value) => value !== undefined && typeof value !== 'boolean';

  r.get('/users', ...adminOnly, (_req, res) => {
    res.json({ users: users.listUsers() });
  });

  r.post('/users', ...adminOnly, (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const email = req.body?.email ? String(req.body.email).trim() : null;
    const password = String(req.body?.password ?? '');
    if (badIsAdmin(req.body?.isAdmin)) return res.status(400).json({ error: 'isAdmin must be true or false.' });
    const isAdmin = req.body?.isAdmin === true;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (username.length > USERNAME_MAX) return res.status(400).json({ error: `Usernames are at most ${USERNAME_MAX} characters.` });
    if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
    try {
      const user = users.createUser({ username, email, password, isAdmin });
      res.status(201).json({ ok: true, user });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // Admin reset of another user's password.
  r.post('/users/:id/password', ...adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!users.getUser(id)) return res.status(404).json({ error: 'User not found.' });
    const password = String(req.body?.password ?? '');
    if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
    users.setPassword(id, password);
    users.deleteUserSessions(id); // force re-login with the new password
    res.json({ ok: true });
  });

  r.patch('/users/:id', ...adminOnly, (req, res) => {
    const id = Number(req.params.id);
    const target = users.getUser(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const { email, isAdmin } = req.body ?? {};
    // Only a real boolean is accepted, so the guard below sees exactly the
    // value that gets applied (0/null/"" can't slip past as "not false").
    if (badIsAdmin(isAdmin)) return res.status(400).json({ error: 'isAdmin must be true or false.' });
    // Guard against demoting the last admin into an admin-less instance.
    if (isAdmin === false && target.isAdmin && users.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin.' });
    }
    const patch = {
      ...(email !== undefined ? { email: email ? String(email).trim() : null } : {}),
      ...(isAdmin !== undefined ? { isAdmin } : {}),
    };
    res.json({ ok: true, user: users.updateUser(id, patch) });
  });

  r.delete('/users/:id', ...adminOnly, (req, res) => {
    const id = Number(req.params.id);
    const target = users.getUser(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    if (target.isAdmin && users.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin.' });
    }
    users.deleteUser(id);
    res.json({ ok: true });
  });

  return r;
}
