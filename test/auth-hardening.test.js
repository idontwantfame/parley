// test/auth-hardening.test.js — login limiter bounds, /users gating, cookie
// parsing, proxy-aware same-origin checks, hashed sessions and async scrypt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { installUsers, USERNAME_MAX } from '../src/store/users.js';
import { authRouter, attachUser, createLoginLimiter, sameOrigin } from '../src/web/auth.js';

// The seeded admin's first-run password is random; pin it to 'admin' here.
const ADMIN_SEED = { firstRunPassword: 'admin', log: { warn() {}, info() {}, log() {} } };

function appWith(db, { trustProxy, loginLimiter } = {}) {
  const users = installUsers(db, ADMIN_SEED);
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '256kb' }));
  app.use(attachUser(users));
  app.use('/api', sameOrigin);
  app.use('/api', authRouter(loginLimiter ? { users, loginLimiter } : { users }));
  return { app, users };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, close: () => server.close() };
}

const send = (base, method, path, body, headers = {}) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
});
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0] ?? null;

// An admin that has already moved off the seeded default password.
function realAdmin(users) {
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'admin-pass-1');
  return admin;
}

test('login limiter keeps a bounded number of entries and evicts the oldest', () => {
  const limiter = createLoginLimiter({ now: () => 1_000, maxEntries: 3 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.fail(key);
  assert.equal(limiter.size(), 3);
});

test('login limiter drops entries that went quiet past the max lockout', () => {
  let t = 0;
  const limiter = createLoginLimiter({ now: () => t, maxLockoutMs: 1_000 });
  limiter.fail('old');
  t = 5_000;
  limiter.fail('new');
  assert.equal(limiter.size(), 1);
});

test('login limiter stores a fixed-size digest instead of the raw key', () => {
  const limiter = createLoginLimiter({ now: () => 1 });
  const huge = 'x'.repeat(100_000);
  for (let i = 0; i < 5; i++) limiter.fail(huge);
  assert.ok(limiter.retryAfterSec(huge) > 0);
  assert.equal(limiter.retryAfterSec('x'.repeat(99_999)), null);
});

test('an over-long login username is rejected before the limiter is touched', async () => {
  const touched = [];
  const loginLimiter = {
    retryAfterSec: (k) => { touched.push(k); return null; },
    fail: (k) => touched.push(k),
    reset: (k) => touched.push(k),
  };
  const { base, close } = await listen(appWith(openDb(':memory:'), { loginLimiter }).app);
  try {
    const res = await send(base, 'POST', '/api/auth/login', { username: 'u'.repeat(USERNAME_MAX + 1), password: 'x' });
    assert.equal(res.status, 400);
    assert.deepEqual(touched, []);
  } finally { close(); }
});

test('user creation enforces the same username length cap', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  realAdmin(users);
  assert.throws(() => users.createUser({ username: 'u'.repeat(USERNAME_MAX + 1), password: 'pw123456' }), /at most/);
  const { base, close } = await listen(app);
  try {
    const cookie = cookieOf(await send(base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-1' }));
    const res = await send(base, 'POST', '/api/users', { username: 'u'.repeat(USERNAME_MAX + 1), password: 'pw123456' }, { cookie });
    assert.equal(res.status, 400);
  } finally { close(); }
});

test('the default-password admin cannot manage users until the password changes', async () => {
  const { app } = appWith(openDb(':memory:'));
  const { base, close } = await listen(app);
  try {
    const cookie = cookieOf(await send(base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin' }));
    const created = await send(base, 'POST', '/api/users', { username: 'eve', password: 'pw123456', isAdmin: true }, { cookie });
    assert.equal(created.status, 403);
    assert.equal((await created.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await fetch(`${base}/api/users`, { headers: { cookie } })).status, 403);
    // me + password change stay reachable.
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status, 200);
    const changed = await send(base, 'POST', '/api/auth/password', { newPassword: 'a-real-password' }, { cookie });
    assert.equal(changed.status, 200);
    const fresh = cookieOf(changed);
    assert.equal((await fetch(`${base}/api/users`, { headers: { cookie: fresh } })).status, 200);
  } finally { close(); }
});

test('the last admin cannot be demoted with a falsy non-boolean isAdmin', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  const admin = realAdmin(users);
  const { base, close } = await listen(app);
  try {
    const cookie = cookieOf(await send(base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-1' }));
    for (const isAdmin of [0, null, '', 'false']) {
      const res = await send(base, 'PATCH', `/api/users/${admin.id}`, { isAdmin }, { cookie });
      assert.equal(res.status, 400, `isAdmin=${JSON.stringify(isAdmin)}`);
    }
    assert.equal(users.getUser(admin.id).isAdmin, true);
    const created = await send(base, 'POST', '/api/users', { username: 'kim', password: 'pw123456', isAdmin: 'false' }, { cookie });
    assert.equal(created.status, 400);
  } finally { close(); }
});

test('a malformed session cookie is treated as logged out, not a 500', async () => {
  const { base, close } = await listen(appWith(openDb(':memory:')).app);
  try {
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: 'parley_session=%E0%A4%A' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user, null);
  } finally { close(); }
});

test('same-origin check honours X-Forwarded-Host from a trusted proxy only', async () => {
  const login = (base, host, extra) => send(base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin' },
    { origin: 'https://notes.example.com', host, ...extra });
  const trusted = await listen(appWith(openDb(':memory:'), { trustProxy: 'loopback' }).app);
  try {
    const res = await login(trusted.base, trusted.host, { 'x-forwarded-host': 'notes.example.com' });
    assert.equal(res.status, 200);
    assert.equal((await login(trusted.base, trusted.host)).status, 403);
  } finally { trusted.close(); }
  const untrusted = await listen(appWith(openDb(':memory:'), { trustProxy: false }).app);
  try {
    const res = await login(untrusted.base, untrusted.host, { 'x-forwarded-host': 'notes.example.com' });
    assert.equal(res.status, 403);
  } finally { untrusted.close(); }
});

test('sessions are stored as SHA-256 digests and still resolve', () => {
  const db = openDb(':memory:');
  const users = installUsers(db, ADMIN_SEED);
  const admin = users.getUserByUsername('admin');
  const { token } = users.createSession(admin.id);
  const stored = db.sql.prepare('SELECT token FROM sessions').all().map((r) => r.token);
  assert.equal(stored.includes(token), false);
  assert.equal(users.getSessionUser(token).username, 'admin');
});

test('existing plaintext sessions are hashed on install and keep working', () => {
  const db = openDb(':memory:');
  const users = installUsers(db, ADMIN_SEED);
  const admin = users.getUserByUsername('admin');
  const legacy = 'ab'.repeat(32);
  db.sql.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(legacy, admin.id, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  const again = installUsers(db, ADMIN_SEED);
  const rows = db.sql.prepare('SELECT token FROM sessions').all();
  assert.equal(rows.some((r) => r.token === legacy), false);
  assert.ok(rows.some((r) => r.token.includes(createHash('sha256').update(legacy).digest('hex'))));
  assert.equal(again.getSessionUser(legacy).username, 'admin');
});

test('expired sessions are purged when a new session is created', () => {
  const db = openDb(':memory:');
  const users = installUsers(db, ADMIN_SEED);
  const admin = users.getUserByUsername('admin');
  users.createSession(admin.id, -1_000);
  users.createSession(admin.id);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
});

test('authenticate yields to the event loop for known and unknown users', async () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  for (const name of ['admin', 'nobody']) {
    let ticked = false;
    const pending = users.authenticate(name, 'wrong-password');
    setImmediate(() => { ticked = true; });
    assert.equal(await pending, null);
    assert.equal(ticked, true, `${name} should hash off the main thread`);
  }
  assert.equal((await users.authenticate('admin', 'admin')).username, 'admin');
});

test('parallel guesses cannot slip past the limiter while scrypt runs', async () => {
  const { base, close } = await listen(appWith(openDb(':memory:')).app);
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      send(base, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong' })));
    const statuses = responses.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, statuses.join(','));
    assert.equal(statuses.filter((s) => s === 429).length, 5);
  } finally { close(); }
});
