// test/users-oidc.test.js — SSO identity columns and helpers on the users store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/store/db.js';
import { installUsers } from '../src/store/users.js';

// The seeded admin's first-run password is random; pin it to 'admin' here.
const ADMIN_SEED = { firstRunPassword: 'admin', log: { warn() {}, info() {}, log() {} } };

const ISS = 'https://auth.example.com/application/o/parley/';

test('migration adds nullable oidc columns and a unique (issuer, subject) index to an existing users table', () => {
  // Arrange: a pre-SSO users table with one row.
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT,
    password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL)`);
  sql.prepare(`INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ('old', 'scrypt$aa$bb', 1, 'x')`).run();

  // Act
  const users = installUsers({ sql });

  // Assert: row untouched, columns present, index unique on the pair.
  const cols = sql.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('oidc_issuer') && cols.includes('oidc_subject'));
  const row = sql.prepare('SELECT * FROM users WHERE username = ?').get('old');
  assert.equal(row.oidc_issuer, null);
  assert.equal(row.password_hash, 'scrypt$aa$bb');
  assert.equal(users.countUsers(), 1); // no default admin seeded over existing users
  const idx = sql.prepare(`PRAGMA index_list(users)`).all().find((i) => i.name === 'users_oidc_identity');
  assert.equal(idx.unique, 1);
  installUsers({ sql }); // idempotent
});

test('createSsoUser stores an unusable password and links the identity', async () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const u = users.createSsoUser({ username: 'Jane', email: 'jane@x.com', issuer: ISS, subject: 'sub-1' });
  assert.equal(u.username, 'jane');
  assert.equal(u.sso, true);
  assert.equal(u.hasPassword, false);
  assert.equal(u.isAdmin, false);
  assert.equal(u.mustChangePassword, false);
  // No password (not even the empty string) signs in.
  assert.equal(await users.authenticate('jane', ''), null);
  assert.equal(await users.authenticate('jane', '!sso'), null);
  assert.equal(users.getUserByOidc(ISS, 'sub-1').id, u.id);
  assert.equal(users.getUserByOidc(ISS, 'other'), null);
  assert.equal(users.getUserByOidc('https://other/', 'sub-1'), null);
});

test('the same (issuer, subject) cannot be linked twice', () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  users.createSsoUser({ username: 'a', issuer: ISS, subject: 's' });
  assert.throws(() => users.createSsoUser({ username: 'b', issuer: ISS, subject: 's' }));
});

test('linkOidc links a local account, keeping its password', async () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const local = users.createUser({ username: 'kim', email: 'Kim@Example.com', password: 'pw123456' });
  assert.equal(local.sso, false);
  assert.equal(local.hasPassword, true);
  const linked = users.linkOidc(local.id, ISS, 'k-1');
  assert.equal(linked.sso, true);
  assert.equal(linked.hasPassword, true);
  assert.ok(await users.authenticate('kim', 'pw123456'));
  assert.equal(users.oidcIdentity(local.id).issuer, ISS);
});

test('findUsersByEmail matches case-insensitively', () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  users.createUser({ username: 'kim', email: 'Kim@Example.com', password: 'pw123456' });
  assert.equal(users.findUsersByEmail('kim@example.COM').length, 1);
  assert.equal(users.findUsersByEmail('nobody@example.com').length, 0);
  assert.equal(users.findUsersByEmail('').length, 0);
});

test('an admin-set password makes an SSO account usable with a password too', async () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const u = users.createSsoUser({ username: 'jo', issuer: ISS, subject: 'j' });
  users.setPassword(u.id, 'pw123456');
  assert.equal(users.getUser(u.id).hasPassword, true);
  assert.ok(await users.authenticate('jo', 'pw123456'));
});

test('listUsers and authenticate expose sso and hasPassword but never identity internals', async () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  users.createSsoUser({ username: 'jo', issuer: ISS, subject: 'j' });
  const list = users.listUsers();
  assert.deepEqual(list.map((u) => [u.username, u.sso, u.hasPassword]), [['admin', false, true], ['jo', true, false]]);
  for (const u of list) {
    assert.equal('oidc_subject' in u || 'oidcSubject' in u || 'password_hash' in u, false);
  }
  const admin = await users.authenticate('admin', 'admin');
  assert.equal(admin.sso, false);
  assert.equal(admin.hasPassword, true);
});

test('revokePasswordOnlySessions ends sessions of accounts without SSO, except the one kept', () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const admin = users.getUserByUsername('admin');
  const jo = users.createUser({ username: 'jo', password: 'pw123456' });
  const sso = users.createSsoUser({ username: 'sam', issuer: ISS, subject: 'sam' });
  const tokens = [admin, jo, sso].map((u) => users.createSession(u.id).token);
  users.revokePasswordOnlySessions(admin.id);
  assert.equal(users.getSessionUser(tokens[0]).username, 'admin'); // the acting admin keeps theirs
  assert.equal(users.getSessionUser(tokens[1]), null);
  assert.equal(users.getSessionUser(tokens[2]).username, 'sam');
});
