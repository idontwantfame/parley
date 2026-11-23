// test/users.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { installUsers, hashPassword, verifyPassword } from '../src/store/users.js';

test('hashPassword + verifyPassword round-trips and rejects wrong passwords', async () => {
  const h = hashPassword('hunter2');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('nope', h), false);
  assert.equal(await verifyPassword('hunter2', 'garbage'), false);
});

// Collects what installUsers logs (the first-run password box).
function logCapture() {
  const lines = [];
  const push = (...args) => lines.push(args.join(' '));
  return { lines, log: { warn: push, info: push, log: push } };
}
const loggedPassword = (lines) => /password:\s*(\S+)/.exec(lines.join('\n'))?.[1];

test('installUsers seeds the admin with a random first-run password, printed to the log once', async () => {
  const db = openDb(':memory:');
  const { lines, log } = logCapture();
  const users = installUsers(db, { log });
  assert.equal(users.countUsers(), 1);
  const password = loggedPassword(lines);
  assert.ok(password && password.length >= 20, `logged password: ${password}`);
  const admin = await users.authenticate('admin', password);
  assert.ok(admin);
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.mustChangePassword, true);
  assert.equal(await users.authenticate('admin', 'admin'), null, 'no well-known default password');
  assert.equal(users.firstRunPasswordInLog(), true);
  assert.equal(users.defaultPasswordActive(), true);

  const again = logCapture();
  installUsers(db, { log: again.log });
  assert.deepEqual(again.lines, [], 'printed only at first boot');
  const other = logCapture();
  installUsers(openDb(':memory:'), { log: other.log });
  assert.notEqual(loggedPassword(other.lines), password, 'random per install');
});

test('an existing database keeps its admin/admin account; it is not reported as a logged first-run password', async () => {
  const db = openDb(':memory:');
  installUsers(db, { firstRunPassword: 'admin', log: logCapture().log });
  db.sql.prepare(`DELETE FROM app_settings WHERE key = 'first_run_password_in_log'`).run(); // as written by older versions
  const users = installUsers(db, { log: logCapture().log });
  assert.ok(await users.authenticate('admin', 'admin'));
  assert.equal(users.defaultPasswordActive(), true);
  assert.equal(users.firstRunPasswordInLog(), false);
});

test('installUsers does not duplicate the admin on re-install', () => {
  const db = openDb(':memory:');
  installUsers(db);
  installUsers(db);
  const users = installUsers(db);
  assert.equal(users.countUsers(), 1);
});

test('username lookup is case-insensitive', async () => {
  const db = openDb(':memory:');
  const users = installUsers(db, { firstRunPassword: 'admin', log: logCapture().log });
  assert.ok(await users.authenticate('ADMIN', 'admin'));
});

test('createUser enforces unique usernames', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.createUser({ username: 'jane', email: 'jane@x.com', password: 'pw1234' });
  assert.throws(() => users.createUser({ username: 'Jane', password: 'other' }), /taken/i);
});

test('setPassword clears must_change_password and changes the credential', async () => {
  const db = openDb(':memory:');
  const users = installUsers(db, { firstRunPassword: 'admin', log: logCapture().log });
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'newsecret');
  assert.equal(await users.authenticate('admin', 'admin'), null);
  const after = await users.authenticate('admin', 'newsecret');
  assert.ok(after);
  assert.equal(after.mustChangePassword, false);
});

test('sessions resolve to a user and expire', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  const admin = users.getUserByUsername('admin');
  const { token } = users.createSession(admin.id);
  assert.equal(users.getSessionUser(token).username, 'admin');
  users.deleteSession(token);
  assert.equal(users.getSessionUser(token), null);
  // An already-expired session is rejected and cleaned up.
  const { token: t2 } = users.createSession(admin.id, -1000);
  assert.equal(users.getSessionUser(t2), null);
});

test('admin counting protects against locking everyone out', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  assert.equal(users.countAdmins(), 1);
  const u = users.createUser({ username: 'bob', password: 'pw1234', isAdmin: true });
  assert.equal(users.countAdmins(), 2);
  users.updateUser(u.id, { isAdmin: false });
  assert.equal(users.countAdmins(), 1);
});

test('createUser stores email and is queryable via listUsers', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw1234' });
  const list = users.listUsers();
  const kim = list.find((u) => u.username === 'kim');
  assert.equal(kim.email, 'kim@example.com');
  assert.equal(kim.isAdmin, false);
  // Public shape never leaks the hash.
  assert.equal('password_hash' in kim, false);
});

test('defaultPasswordActive is true for the seeded admin, false after change', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  assert.equal(users.defaultPasswordActive(), true); // seeded admin/admin
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'a-real-password');
  assert.equal(users.defaultPasswordActive(), false);
});
