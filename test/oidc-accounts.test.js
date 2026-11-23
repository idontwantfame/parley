// test/oidc-accounts.test.js — who may sign in with SSO and which local
// account they land in (allowlist, linking, auto-create, admin sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { installUsers, USERNAME_MAX } from '../src/store/users.js';
import { AUTH_DEFAULTS, autoCreateEffective } from '../src/config/auth-settings.js';
import { profileFromClaims, resolveSsoAccount, usernameFor } from '../src/web/oidc-accounts.js';

// The seeded admin's first-run password is random; pin it to 'admin' here.
const ADMIN_SEED = { firstRunPassword: 'admin', log: { warn() {}, info() {}, log() {} } };

const ISS = 'https://auth.example.com/application/o/parley/';

// Automatic account creation needs a group allowlist, so unless a test sets
// its own, everyone signing in here is in the allowed MEMBERS group.
const MEMBERS = 'parley-users';
const withMembers = (groups) => [...(Array.isArray(groups) ? groups : []), MEMBERS];

function setup(extra = {}) {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const warnings = [];
  const ownAllowlist = extra.allowedGroups !== undefined;
  const settings = { ...AUTH_DEFAULTS, enabled: true, allowedGroups: [MEMBERS], ...extra };
  const signIn = (claims) => resolveSsoAccount({
    users, settings, log: { warn: (m) => warnings.push(m), info() {} },
    profile: profileFromClaims({ iss: ISS, sub: 'sub-1', ...claims,
      ...(ownAllowlist ? {} : { groups: withMembers(claims.groups) }) }, settings.groupsClaim),
  });
  return { users, warnings, signIn };
}

test('profileFromClaims reads standard claims and the configured groups claim', () => {
  const p = profileFromClaims({ iss: ISS, sub: 's', email: ' a@b.c ', email_verified: true, preferred_username: 'al',
    roles: ['x', 3, 'y'] }, 'roles');
  assert.deepEqual(p, { issuer: ISS, subject: 's', email: 'a@b.c', emailVerified: true, preferredUsername: 'al', groups: ['x', 'y'] });
  assert.deepEqual(profileFromClaims({ iss: ISS, sub: 's', groups: 'solo' }, 'groups').groups, ['solo']);
  assert.equal(profileFromClaims({ iss: ISS, sub: 's', email_verified: 'yes' }, 'groups').emailVerified, false);
});

test('usernameFor prefers preferred_username, then the email local part, then "user"', () => {
  assert.equal(usernameFor({ preferredUsername: ' Jane Doe ', email: 'x@y' }), 'jane-doe');
  assert.equal(usernameFor({ preferredUsername: '', email: 'Kim.Lee@example.com' }), 'kim.lee');
  assert.equal(usernameFor({ preferredUsername: '\u0007', email: '' }), 'user');
  assert.equal(usernameFor({ preferredUsername: 'x'.repeat(200) }).length, USERNAME_MAX);
});

test('a first-time user gets a new non-admin SSO account', () => {
  const { users, signIn } = setup();
  const { user, error } = signIn({ preferred_username: 'jane', email: 'jane@example.com', email_verified: true });
  assert.equal(error, undefined);
  assert.equal(user.username, 'jane');
  assert.equal(user.email, 'jane@example.com');
  assert.equal(user.sso, true);
  assert.equal(user.isAdmin, false);
  assert.equal(user.hasPassword, false);
  // Signing in again lands in the same account.
  assert.equal(signIn({ preferred_username: 'renamed' }).user.id, user.id);
  assert.equal(users.countUsers(), 2);
});

test('a taken username is de-duplicated rather than linked', () => {
  const { users, signIn } = setup();
  const { user } = signIn({ preferred_username: 'admin' });
  assert.equal(user.username, 'admin-2');
  assert.equal(users.getUserByUsername('admin').oidc_subject, null);
});

test('a verified email links to the existing local account', () => {
  const { users, signIn } = setup();
  const local = users.createUser({ username: 'kim', email: 'Kim@Example.com', password: 'pw123456' });
  const { user } = signIn({ preferred_username: 'kimmy', email: 'kim@example.com', email_verified: true });
  assert.equal(user.id, local.id);
  assert.equal(user.sso, true);
  assert.equal(user.hasPassword, true);
});

test('an unverified email never links; a separate account is created without that email', () => {
  const { users, signIn } = setup();
  const local = users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  const { user } = signIn({ preferred_username: 'kim', email: 'kim@example.com', email_verified: false });
  assert.notEqual(user.id, local.id);
  assert.equal(user.username, 'kim-2');
  assert.equal(user.email, null);
  assert.equal(users.getUser(local.id).sso, false);
});

test('an email shared by several local accounts, or one already linked elsewhere, is a conflict', () => {
  const { users, signIn } = setup();
  users.createUser({ username: 'a', email: 'dup@example.com', password: 'pw123456' });
  users.createUser({ username: 'b', email: 'dup@example.com', password: 'pw123456' });
  assert.deepEqual(signIn({ email: 'dup@example.com', email_verified: true }), { error: 'account_conflict' });

  const other = setup();
  other.users.createSsoUser({ username: 'c', email: 'c@example.com', issuer: ISS, subject: 'someone-else' });
  assert.deepEqual(other.signIn({ email: 'c@example.com', email_verified: true }), { error: 'account_conflict' });
});

test('with auto-create off only linked (or verified-email linkable) accounts may sign in', () => {
  const { users, signIn } = setup({ autoCreate: false });
  assert.deepEqual(signIn({ preferred_username: 'new' }), { error: 'no_account' });
  users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  assert.equal(signIn({ email: 'kim@example.com', email_verified: false }).error, 'no_account');
  assert.equal(signIn({ email: 'kim@example.com', email_verified: true }).user.username, 'kim');
  assert.equal(users.countUsers(), 2);
});

test('the group allowlist rejects outsiders, even already-linked ones', () => {
  const { signIn } = setup({ allowedGroups: ['staff', 'ops'] });
  assert.deepEqual(signIn({ groups: ['guests'] }), { error: 'not_allowed' });
  assert.deepEqual(signIn({}), { error: 'not_allowed' });
  assert.ok(signIn({ groups: ['guests', 'ops'] }).user);
  assert.deepEqual(signIn({ groups: ['guests'] }), { error: 'not_allowed' }); // linked now, still refused
});

test('the admin group promotes and demotes at every sign-in', () => {
  const { users, signIn } = setup({ adminGroup: 'parley-admins' });
  const created = signIn({ preferred_username: 'boss', groups: ['parley-admins'] }).user;
  assert.equal(created.isAdmin, true);
  // Another admin exists (the seeded one), so a demotion goes through.
  assert.equal(signIn({ groups: [] }).user.isAdmin, false);
  assert.equal(signIn({ groups: ['parley-admins'] }).user.isAdmin, true);
  assert.equal(users.countAdmins(), 2);
});

test('the admin group never demotes the last remaining admin', () => {
  const { users, warnings, signIn } = setup({ adminGroup: 'parley-admins' });
  const boss = signIn({ preferred_username: 'boss', groups: ['parley-admins'] }).user;
  users.deleteUser(users.getUserByUsername('admin').id);
  assert.equal(users.countAdmins(), 1);
  const after = signIn({ groups: [] }).user;
  assert.equal(after.id, boss.id);
  assert.equal(after.isAdmin, true);
  assert.ok(warnings.some((w) => /last/i.test(w)));
});

test('without an admin group, admin status is left to manual management', () => {
  const { users, signIn } = setup();
  const u = signIn({ groups: ['parley-admins'] }).user;
  assert.equal(u.isAdmin, false);
  users.updateUser(u.id, { isAdmin: true });
  assert.equal(signIn({ groups: [] }).user.isAdmin, true);
});

test('usernames are NFKC-normalized and limited to letters, digits, ".", "_" and "-"', () => {
  assert.equal(usernameFor({ preferredUsername: 'ｊａｎｅ' }), 'jane'); // full-width → ASCII
  assert.equal(usernameFor({ preferredUsername: 'Jane Doe!' }), 'jane-doe');
  assert.equal(usernameFor({ preferredUsername: 'a/b\\c<d>' }), 'a-b-c-d');
  assert.equal(usernameFor({ preferredUsername: 'Zoë_O.K' }), 'zoë_o.k');
  assert.equal(usernameFor({ preferredUsername: '🙂🙂', email: '' }), 'user');
  assert.equal(usernameFor({ preferredUsername: '‮​', email: 'Ann+tag@x.org' }), 'ann-tag');
  const long = usernameFor({ preferredUsername: `${'x'.repeat(USERNAME_MAX - 1)} y` });
  assert.ok(long.length <= USERNAME_MAX && !long.endsWith('-'));
});

test('cutting a username to the length limit never leaves half of a surrogate pair', () => {
  // U+20000 is a letter outside the BMP (two UTF-16 units) straddling the limit.
  const name = usernameFor({ preferredUsername: `${'x'.repeat(USERNAME_MAX - 1)}\u{20000}` });
  assert.ok(name.length <= USERNAME_MAX);
  assert.ok(name.isWellFormed(), JSON.stringify(name));
});

test('a de-duplicated long username stays well-formed after making room for the suffix', () => {
  const { users, signIn } = setup();
  const taken = `${'x'.repeat(USERNAME_MAX - 3)}\u{20000}x`; // exactly USERNAME_MAX units
  users.createUser({ username: taken, password: 'pw123456' });
  const { user } = signIn({ preferred_username: taken });
  assert.notEqual(user.username, taken);
  assert.ok(user.username.isWellFormed(), JSON.stringify(user.username));
  assert.match(user.username, /^[\p{L}\p{N}._-]+$/u);
});

test('email_verified counts only as true or "true"', () => {
  const v = (value) => profileFromClaims({ iss: ISS, sub: 's', email_verified: value }, 'groups').emailVerified;
  assert.equal(v(true), true);
  assert.equal(v('true'), true);
  for (const no of [false, 'false', 'TRUE', 1, 'yes', null, undefined, {}]) assert.equal(v(no), false, String(no));
});

test('linking by verified email lifts a forced password change and retires the temporary password', async () => {
  const { users, signIn } = setup();
  const admin = users.getUserByUsername('admin'); // seeded admin/admin, must change password
  users.updateUser(admin.id, { email: 'root@example.com' });
  const { user } = signIn({ email: 'root@example.com', email_verified: true });
  assert.equal(user.id, admin.id);
  assert.equal(user.mustChangePassword, false);
  assert.equal(await users.authenticate('admin', 'admin'), null); // the default password no longer works
  assert.equal(users.defaultPasswordActive(), false);
});

test('linking an account with a real password keeps that password', async () => {
  const { users, signIn } = setup();
  users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  signIn({ email: 'kim@example.com', email_verified: 'true' });
  assert.ok(await users.authenticate('kim', 'pw123456'));
});

test('auto-create takes effect only with a group allowlist; otherwise only existing accounts may sign in', () => {
  const users = installUsers(openDb(':memory:'), ADMIN_SEED);
  const settings = { ...AUTH_DEFAULTS, enabled: true, autoCreate: true, allowedGroups: [] };
  const signIn = (claims) => resolveSsoAccount({ users, settings, log: { warn() {}, info() {} },
    profile: profileFromClaims({ iss: ISS, sub: 'sub-x', ...claims }, settings.groupsClaim) });
  assert.deepEqual(signIn({ preferred_username: 'stranger' }), { error: 'no_account' });
  assert.equal(users.countUsers(), 1);
  users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  assert.equal(signIn({ email: 'kim@example.com', email_verified: true }).user.username, 'kim');
  assert.equal(signIn({}).user.username, 'kim', 'the linked account keeps working');
});

test('autoCreateEffective needs auto-create on and a non-empty group allowlist', () => {
  assert.equal(autoCreateEffective({ autoCreate: true, allowedGroups: [] }), false);
  assert.equal(autoCreateEffective({ autoCreate: true, allowedGroups: ['staff'] }), true);
  assert.equal(autoCreateEffective({ autoCreate: false, allowedGroups: ['staff'] }), false);
});
