// User accounts + login sessions for the web dashboard.
//
// Self-hosted and dependency-free: passwords are hashed with Node's built-in
// scrypt (salt per user, constant-time compare), sessions are opaque random
// tokens stored server-side and referenced by an httpOnly cookie. No JWTs, no
// external auth service — everything lives in the same SQLite db as meetings.
//
// On first run a default `admin` / `admin` account is seeded so a fresh
// self-hoster can log in immediately; the UI nudges them to change it. Admins
// can add more users (email + password); any user can change their own password.

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Usernames longer than this are rejected at creation and at login (so a huge
// login body never reaches the rate limiter or the database).
export const USERNAME_MAX = 64;
// Session rows store this prefix + the token's SHA-256, never the token itself,
// so a leaked database or backup cannot be replayed as live cookies.
const SESSION_HASH_PREFIX = 'sha256:';
const hashToken = (token) => `${SESSION_HASH_PREFIX}${createHash('sha256').update(String(token)).digest('hex')}`;

// scrypt hash, stored as `scrypt$<saltHex>$<hashHex>` so the algorithm is
// self-describing (lets us migrate later without guessing).
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Async (libuv threadpool) so a login never blocks the event loop.
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try { actual = await scryptAsync(String(password), salt, expected.length); }
  catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Unknown usernames are verified against this throwaway hash so they cost the
// same scrypt work as real ones (no username enumeration by response time).
let dummyHash = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

// One-time migration: hash any session tokens stored in plaintext by older
// versions, so existing logins survive the switch to hashed storage.
function hashLegacySessions(sql) {
  const legacy = sql.prepare(`SELECT token FROM sessions WHERE token NOT LIKE ?`).all(`${SESSION_HASH_PREFIX}%`);
  if (legacy.length === 0) return;
  const update = sql.prepare(`UPDATE sessions SET token = ? WHERE token = ?`);
  sql.exec('BEGIN');
  try {
    for (const { token } of legacy) update.run(hashToken(token), token);
    sql.exec('COMMIT');
  } catch (e) { sql.exec('ROLLBACK'); throw e; }
}

const PUBLIC_COLS = `id, username, email, is_admin AS isAdmin, must_change_password AS mustChangePassword, created_at AS createdAt`;
function publicUser(row) {
  if (!row) return null;
  return { ...row, isAdmin: !!row.isAdmin, mustChangePassword: !!row.mustChangePassword };
}

export function normalizeUsername(name) {
  return String(name ?? '').trim().toLowerCase();
}

// Attach user/session helpers onto an open db handle (the object returned by
// openDb). Idempotent: creates the tables and seeds the default admin once.
export function installUsers(db, { now = () => new Date().toISOString() } = {}) {
  const sql = db.sql;
  sql.exec(SCHEMA);
  hashLegacySessions(sql);

  const api = {
    // ── Users ───────────────────────────────────────────────────────────────
    countUsers() {
      return sql.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
    },
    listUsers() {
      return sql.prepare(`SELECT ${PUBLIC_COLS} FROM users ORDER BY id`).all().map(publicUser);
    },
    getUser(id) {
      return publicUser(sql.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id));
    },
    getUserByUsername(username) {
      return sql.prepare(`SELECT * FROM users WHERE username = ?`).get(normalizeUsername(username));
    },
    // Create a user. Throws on a duplicate username (caller maps to a 409).
    createUser({ username, email = null, password, isAdmin = false, mustChangePassword = false }) {
      const uname = normalizeUsername(username);
      if (!uname) throw new Error('Username is required.');
      if (uname.length > USERNAME_MAX) throw new Error(`Usernames are at most ${USERNAME_MAX} characters.`);
      if (!password) throw new Error('Password is required.');
      if (this.getUserByUsername(uname)) throw new Error('That username is already taken.');
      const r = sql.prepare(
        `INSERT INTO users (username, email, password_hash, is_admin, must_change_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(uname, email || null, hashPassword(password), isAdmin ? 1 : 0, mustChangePassword ? 1 : 0, now());
      return this.getUser(r.lastInsertRowid);
    },
    setPassword(userId, password) {
      if (!password) throw new Error('Password is required.');
      sql.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
        .run(hashPassword(password), userId);
    },
    updateUser(userId, { email, isAdmin } = {}) {
      const fields = [];
      const args = [];
      if (email !== undefined) { fields.push('email = ?'); args.push(email || null); }
      if (isAdmin !== undefined) { fields.push('is_admin = ?'); args.push(isAdmin ? 1 : 0); }
      if (!fields.length) return this.getUser(userId);
      args.push(userId);
      sql.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...args);
      return this.getUser(userId);
    },
    deleteUser(userId) {
      sql.exec('BEGIN');
      try {
        sql.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
        sql.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
        sql.exec('COMMIT');
      } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
    countAdmins() {
      return sql.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`).get().c;
    },
    // True while any admin still carries the seeded default password (the UI uses
    // this to show the login-screen hint only when it's actually relevant).
    defaultPasswordActive() {
      return sql.prepare(
        `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND must_change_password = 1`
      ).get().c > 0;
    },

    // ── Auth ────────────────────────────────────────────────────────────────
    // Verify credentials; resolves to the public user on success, else null.
    async authenticate(username, password) {
      const row = this.getUserByUsername(username);
      const valid = await verifyPassword(password, row?.password_hash ?? getDummyHash());
      if (!row || !valid) return null;
      return publicUser({ id: row.id, username: row.username, email: row.email,
        isAdmin: row.is_admin, mustChangePassword: row.must_change_password, createdAt: row.created_at });
    },

    // ── Sessions ──────────────────────────────────────────────────────────────
    // Creating a session (login, password change) also purges expired ones.
    createSession(userId, ttlMs = SESSION_TTL_MS) {
      this.purgeExpiredSessions();
      const token = randomBytes(32).toString('hex');
      const created = now();
      const expires = new Date(Date.now() + ttlMs).toISOString();
      sql.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(hashToken(token), userId, created, expires);
      return { token, expiresAt: expires };
    },
    // Resolve a session token to its public user, or null if missing/expired.
    getSessionUser(token) {
      if (!token) return null;
      const row = sql.prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(hashToken(token));
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        this.deleteSession(token);
        return null;
      }
      return this.getUser(row.user_id);
    },
    deleteSession(token) {
      if (token) sql.prepare(`DELETE FROM sessions WHERE token = ?`).run(hashToken(token));
    },
    deleteUserSessions(userId) {
      sql.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    },
    purgeExpiredSessions() {
      // Real clock, matching how createSession computes expires_at.
      sql.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(new Date().toISOString());
    },
  };

  // Seed a default admin the first time the app boots with no users, so a fresh
  // self-hoster can log in right away. Flagged must_change_password so the UI
  // can prompt them to set a real password.
  if (api.countUsers() === 0) {
    api.createUser({ username: 'admin', email: null, password: 'admin', isAdmin: true, mustChangePassword: true });
  }

  return api;
}
