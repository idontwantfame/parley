// test/oidc-flow.test.js — end-to-end single sign-on through the real web
// server against a fake OpenID provider: login → provider → callback → session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { installUsers } from '../src/store/users.js';
import { createWebServer } from '../src/web/server.js';

// The seeded admin's first-run password is random; pin it to 'admin' here.
const ADMIN_SEED = { firstRunPassword: 'admin', log: { warn() {}, info() {}, log() {} } };
import { resolveAuthSettings } from '../src/config/auth-settings.js';
import { createOidcService } from '../src/web/oidc-service.js';
import { settingsFingerprint } from '../src/store/oidc-settings.js';
import { startFakeProvider } from './helpers/fake-oidc-provider.js';

function capture() {
  const lines = [];
  const push = (...args) => lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
  return { lines, log: { info: push, warn: push, error: push } };
}

const cookieNamed = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
const pair = (setCookie) => setCookie?.split(';')[0] ?? null;

// Accounts are only created automatically with a group allowlist, so by
// default the allowlist is MEMBERS and whoever signs in belongs to it.
const MEMBERS = 'parley-users';

// A running dashboard wired to a fake provider. `auth` adds env-style settings.
async function setup(t, { auth = {}, ssoOn = true } = {}) {
  const provider = await startFakeProvider();
  provider.user = { ...provider.user, groups: [MEMBERS] };
  const db = openDb(':memory:');
  const users = installUsers(db, ADMIN_SEED);
  const env = { auth: resolveAuthSettings({}) };
  const { lines, log } = capture();
  const oidc = createOidcService({ env, log, envPath: join(mkdtempSync(join(tmpdir(), 'parley-oidc-')), '.env') });
  const server = createWebServer({ db, users, oidc }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await provider.close(); });
  env.auth = resolveAuthSettings({
    OIDC_ENABLED: ssoOn ? 'true' : 'false', OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: provider.clientId,
    OIDC_CLIENT_SECRET: provider.clientSecret, PUBLIC_URL: base, OIDC_ALLOWED_GROUPS: MEMBERS, ...auth,
  });
  return { provider, users, base, env, oidc, logs: lines };
}

// Drive the browser side of a full sign-in.
async function signIn({ base }, { returnTo = '/meetings/7', headers = {} } = {}) {
  const login = await fetch(`${base}/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual', headers });
  assert.equal(login.status, 302, `login status ${login.status}`);
  const flowCookie = pair(cookieNamed(login, 'parley_oidc'));
  const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const callbackUrl = authorize.headers.get('location');
  const cookie = [flowCookie, headers.cookie].filter(Boolean).join('; ');
  const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { ...headers, cookie } });
  return { login, flowCookie, callbackUrl, callback, location: callback.headers.get('location'),
    session: pair(cookieNamed(callback, 'parley_session')) };
}

const me = async (base, cookie) => (await fetch(`${base}/api/auth/me`, { headers: cookie ? { cookie } : {} })).json();
const jpost = (base, path, body, cookie) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}),
});

test('happy path: first SSO sign-in auto-creates an account and starts a session', async (t) => {
  const ctx = await setup(t);
  const run = await signIn(ctx);

  // The login redirect is an authorization-code + PKCE (S256) request with state and nonce.
  const authz = ctx.provider.requests.authorize[0];
  assert.equal(authz.response_type, 'code');
  assert.equal(authz.client_id, ctx.provider.clientId);
  assert.equal(authz.redirect_uri, `${ctx.base}/api/auth/oidc/callback`);
  assert.equal(authz.scope, 'openid profile email');
  assert.equal(authz.code_challenge_method, 'S256');
  assert.ok(authz.state && authz.nonce && authz.code_challenge);
  assert.notEqual(authz.state, run.flowCookie.split('=')[1]); // the flow id never travels in the URL
  const flowAttrs = cookieNamed(run.login, 'parley_oidc');
  assert.match(flowAttrs, /HttpOnly/i);
  assert.match(flowAttrs, /SameSite=Lax/i);
  assert.match(flowAttrs, /Path=\/api\/auth\/oidc/);
  assert.match(flowAttrs, /Max-Age=600/);

  assert.equal(run.callback.status, 302);
  assert.equal(run.location, '/meetings/7');
  assert.ok(run.session);
  assert.match(cookieNamed(run.callback, 'parley_oidc'), /Expires=Thu, 01 Jan 1970/); // flow cookie cleared
  const who = await me(ctx.base, run.session);
  assert.equal(who.user.username, 'jane');
  assert.equal(who.user.email, 'jane@example.com');
  assert.equal(who.user.sso, true);
  assert.equal(who.user.hasPassword, false);
  assert.equal(who.user.isAdmin, false);
  assert.deepEqual(who.sso, { enabled: true, label: 'Sign in with SSO' });
  assert.equal(who.passwordLogin, true);
  // The session behaves like any other: the data API accepts it.
  assert.equal((await fetch(`${ctx.base}/api/guilds`, { headers: { cookie: run.session } })).status, 200);
});

test('a verified email links the sign-in to the existing local account', async (t) => {
  const ctx = await setup(t);
  const kim = ctx.users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  ctx.provider.user = { sub: 'kim-sub', preferred_username: 'kimmy', email: 'KIM@example.com', email_verified: true, groups: [MEMBERS] };
  const run = await signIn(ctx);
  const who = await me(ctx.base, run.session);
  assert.equal(who.user.id, kim.id);
  assert.equal(who.user.sso, true);
  assert.equal(who.user.hasPassword, true);
});

test('an unverified email is never used to link accounts', async (t) => {
  const ctx = await setup(t);
  const kim = ctx.users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw123456' });
  ctx.provider.user = { sub: 'attacker', preferred_username: 'kim', email: 'kim@example.com', email_verified: false, groups: [MEMBERS] };
  const run = await signIn(ctx);
  const who = await me(ctx.base, run.session);
  assert.notEqual(who.user.id, kim.id);
  assert.equal(who.user.username, 'kim-2');
  assert.equal(ctx.users.getUser(kim.id).sso, false);
});

test('the group allowlist refuses users outside it', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ALLOWED_GROUPS: 'staff,ops' } });
  ctx.provider.user = { ...ctx.provider.user, groups: ['guests'] };
  const refused = await signIn(ctx);
  assert.equal(refused.location, '/?authError=not_allowed');
  assert.equal(refused.session, null);
  assert.equal(ctx.users.countUsers(), 1);
  ctx.provider.user = { ...ctx.provider.user, groups: ['ops'] };
  assert.equal((await signIn(ctx)).location, '/meetings/7');
});

test('groups missing from the ID token are fetched from userinfo', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ALLOWED_GROUPS: 'staff', OIDC_ADMIN_GROUP: 'admins' } });
  ctx.provider.groupsInUserinfoOnly = true;
  ctx.provider.user = { ...ctx.provider.user, groups: ['staff', 'admins'] };
  const run = await signIn(ctx);
  assert.equal(run.location, '/meetings/7');
  assert.equal(ctx.provider.requests.userinfo, 1);
  assert.equal((await me(ctx.base, run.session)).user.isAdmin, true);
});

test('when groups are needed and userinfo fails, sign-in fails closed', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ALLOWED_GROUPS: 'staff' } });
  ctx.provider.groupsInUserinfoOnly = true;
  ctx.provider.userinfoFails = true;
  ctx.provider.user = { ...ctx.provider.user, groups: ['staff'] };
  assert.equal((await signIn(ctx)).location, '/?authError=provider_error');
});

test('the admin group promotes and demotes, but never the last admin', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ADMIN_GROUP: 'parley-admins' } });
  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS, 'parley-admins'] };
  let who = await me(ctx.base, (await signIn(ctx)).session);
  assert.equal(who.user.isAdmin, true);

  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS] };
  who = await me(ctx.base, (await signIn(ctx)).session);
  assert.equal(who.user.isAdmin, false); // the seeded admin still exists

  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS, 'parley-admins'] };
  await signIn(ctx);
  ctx.users.deleteUser(ctx.users.getUserByUsername('admin').id);
  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS] };
  who = await me(ctx.base, (await signIn(ctx)).session);
  assert.equal(who.user.isAdmin, true);
  assert.ok(ctx.logs.some((l) => /last admin/i.test(l)));
});

test('with auto-create off, unknown identities get no_account', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_AUTO_CREATE: 'false' } });
  const run = await signIn(ctx);
  assert.equal(run.location, '/?authError=no_account');
  assert.equal(run.session, null);
});

test('a callback without the flow cookie, a replay, or a wrong state is a state_mismatch', async (t) => {
  const ctx = await setup(t);
  // No cookie (e.g. a login CSRF attempt with the attacker's own code).
  const login = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const flowCookie = pair(cookieNamed(login, 'parley_oidc'));
  const callbackUrl = (await fetch(login.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  const noCookie = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(noCookie.headers.get('location'), '/?authError=state_mismatch');

  // A forged state (e.g. a stray cross-site callback riding on the victim's
  // cookie) neither consumes the flow nor clears its cookie...
  const tampered = new URL(callbackUrl);
  tampered.searchParams.set('state', 'forged');
  const bad = await fetch(tampered, { redirect: 'manual', headers: { cookie: flowCookie } });
  assert.equal(bad.headers.get('location'), '/?authError=state_mismatch');
  assert.equal(cookieNamed(bad, 'parley_oidc'), null);
  // ...so the legitimate callback still completes.
  const after = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: flowCookie } });
  assert.equal(after.headers.get('location'), '/');
  assert.ok(cookieNamed(after, 'parley_session'));

  // A successful callback cannot be replayed.
  const run = await signIn(ctx);
  assert.ok(run.session);
  const replay = await fetch(run.callbackUrl, { redirect: 'manual', headers: { cookie: run.flowCookie } });
  assert.equal(replay.headers.get('location'), '/?authError=state_mismatch');
  assert.equal(cookieNamed(replay, 'parley_session'), null);
});

test('returnTo is limited to same-origin relative paths', async (t) => {
  const ctx = await setup(t);
  for (const evil of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/\t/evil.example']) {
    assert.equal((await signIn(ctx, { returnTo: evil })).location, '/', evil);
  }
  assert.equal((await signIn(ctx, { returnTo: '/search?q=x' })).location, '/search?q=x');
});

test('with SSO disabled: login 404s, the callback reports sso_disabled, me says disabled', async (t) => {
  const ctx = await setup(t, { ssoOn: false });
  const login = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 404);
  assert.equal(cookieNamed(login, 'parley_oidc'), null);
  const cb = await fetch(`${ctx.base}/api/auth/oidc/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?authError=sso_disabled');
  const who = await me(ctx.base);
  assert.deepEqual(who.sso, { enabled: false, label: 'Sign in with SSO' });
  assert.equal(who.passwordLogin, true);
  assert.equal(ctx.provider.requests.discovery, 0);
});

test('provider errors and invalid ID tokens end in provider_error without leaking details', async (t) => {
  const ctx = await setup(t);
  ctx.provider.authorizeError = 'access_denied';
  const denied = await signIn(ctx);
  assert.equal(denied.location, '/?authError=provider_error');
  ctx.provider.authorizeError = null;

  for (const tamper of ['signature', 'nonce', 'audience', 'expired', 'issuer']) {
    ctx.provider.tamper = tamper;
    const run = await signIn(ctx);
    assert.equal(run.location, '/?authError=provider_error', tamper);
    assert.equal(run.session, null, tamper);
  }
  ctx.provider.tamper = null;
  assert.equal(ctx.users.countUsers(), 1);
  const logged = ctx.logs.join('\n');
  assert.equal(logged.includes(ctx.provider.clientSecret), false);
  assert.doesNotMatch(logged, /eyJ[\w-]+\.eyJ/); // no JWTs in logs
});

test('a wrong client secret fails the token exchange as provider_error', async (t) => {
  const ctx = await setup(t);
  ctx.env.auth = { ...ctx.env.auth, clientSecret: 'wrong' };
  assert.equal((await signIn(ctx)).location, '/?authError=provider_error');
});

test('an unreachable provider: login reports provider_error and password login stays on', async (t) => {
  const ctx = await setup(t, { auth: { PASSWORD_LOGIN: 'false' } });
  await ctx.provider.close();
  const login = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/?authError=provider_error');
  const who = await me(ctx.base);
  assert.equal(who.sso.enabled, false);
  assert.equal(who.passwordLogin, true);
  assert.equal((await jpost(ctx.base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 200);
});

test('PASSWORD_LOGIN=false takes effect only after an admin SSO sign-in verified the settings', async (t) => {
  const ctx = await setup(t, { auth: { PASSWORD_LOGIN: 'false', OIDC_ADMIN_GROUP: 'admins' } });
  await ctx.oidc.ensure();
  assert.equal((await me(ctx.base)).passwordLogin, true); // SSO works, but nobody proved it yet
  await signIn(ctx); // a non-admin sign-in does not verify
  assert.equal((await me(ctx.base)).passwordLogin, true);
  ctx.provider.user = { sub: 'boss', preferred_username: 'boss', email: 'boss@example.com', email_verified: true, groups: [MEMBERS, 'admins'] };
  await signIn(ctx);
  assert.equal((await me(ctx.base)).passwordLogin, false);
  const res = await jpost(ctx.base, '/api/auth/login', { username: 'admin', password: 'admin' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Password sign-in is turned off. Use single sign-on.' });
});

test('when password login turns off, password-only sessions end and password changes are refused', async (t) => {
  const ctx = await setup(t, { auth: { PASSWORD_LOGIN: 'false', OIDC_ADMIN_GROUP: 'admins' } });
  const jo = ctx.users.createUser({ username: 'jo', password: 'pw123456' });
  const joSession = pair(cookieNamed(await jpost(ctx.base, '/api/auth/login', { username: 'jo', password: 'pw123456' }), 'parley_session'));
  assert.equal((await me(ctx.base, joSession)).user.username, 'jo');
  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS, 'admins'] };
  const admin = await signIn(ctx); // verifies → password login is now effectively off
  assert.equal((await me(ctx.base, joSession)).user, null);
  assert.equal((await me(ctx.base, admin.session)).user.username, 'jane');
  // A non-SSO account that still had a session cannot use the password route.
  const leftover = `parley_session=${ctx.users.createSession(jo.id).token}`;
  const res = await jpost(ctx.base, '/api/auth/password', { currentPassword: 'pw123456', newPassword: 'another-pass' }, leftover);
  assert.equal(res.status, 403);
  assert.ok(await ctx.users.authenticate('jo', 'pw123456'));
});

test('GET /api/auth/oidc/login is rate limited per client', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 20; i++) {
    assert.equal((await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' })).status, 302, `attempt ${i + 1}`);
  }
  const limited = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('content-type'), /text\/plain/);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match(await limited.text(), /too many/i);
  assert.equal(cookieNamed(limited, 'parley_oidc'), null);
});

test('cookies are Secure when PUBLIC_URL is https, even over a plain-http hop', async (t) => {
  const ctx = await setup(t);
  ctx.env.auth = { ...ctx.env.auth, publicUrl: 'https://notes.example.com' };
  const login = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.match(cookieNamed(login, 'parley_oidc'), /;\s*Secure/i);
  const pw = await jpost(ctx.base, '/api/auth/login', { username: 'admin', password: 'admin' });
  assert.match(cookieNamed(pw, 'parley_session'), /;\s*Secure/i);
  const out = await jpost(ctx.base, '/api/auth/logout', {}, pair(cookieNamed(pw, 'parley_session')));
  assert.match(cookieNamed(out, 'parley_session'), /;\s*Secure/i);
});

test('an SSO-only account cannot change a password it does not have, until an admin sets one', async (t) => {
  const ctx = await setup(t);
  const run = await signIn(ctx);
  const res = await jpost(ctx.base, '/api/auth/password', { currentPassword: '', newPassword: 'a-long-password' }, run.session);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'This account signs in with SSO.' });
  const jane = ctx.users.getUserByUsername('jane');
  ctx.users.setPassword(jane.id, 'admin-set-pass');
  const fresh = pair(cookieNamed(await jpost(ctx.base, '/api/auth/login', { username: 'jane', password: 'admin-set-pass' }), 'parley_session'));
  const changed = await jpost(ctx.base, '/api/auth/password', { currentPassword: 'admin-set-pass', newPassword: 'another-pass' }, fresh);
  assert.equal(changed.status, 200);
});

test('the user list marks SSO-linked accounts', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ADMIN_GROUP: 'admins' } });
  ctx.provider.user = { ...ctx.provider.user, groups: [MEMBERS, 'admins'] };
  const run = await signIn(ctx);
  const list = await (await fetch(`${ctx.base}/api/users`, { headers: { cookie: run.session } })).json();
  assert.deepEqual(list.users.map((u) => [u.username, u.sso]), [['admin', false], ['jane', true]]);
});

test('signing in with SSO replaces any previous session in that browser', async (t) => {
  const ctx = await setup(t);
  const old = pair(cookieNamed(await jpost(ctx.base, '/api/auth/login', { username: 'admin', password: 'admin' }), 'parley_session'));
  const run = await signIn(ctx, { headers: { cookie: `${old}` } });
  assert.ok(run.session);
  assert.equal((await me(ctx.base, old)).user, null);
});

test('the flow cookie is Secure behind an https proxy', async (t) => {
  const ctx = await setup(t);
  const login = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
  assert.match(cookieNamed(login, 'parley_oidc'), /;\s*Secure/i);
});

// A server (re)starting with settings straight from .env: no provider needed.
function bootServer({ passwordLogin, verified }) {
  const db = openDb(':memory:');
  const users = installUsers(db, ADMIN_SEED);
  const jo = users.createUser({ username: 'jo', password: 'pw123456' });
  const sam = users.createSsoUser({ username: 'sam', issuer: 'https://idp.example/', subject: 'sam' });
  const tokens = { jo: users.createSession(jo.id).token, sam: users.createSession(sam.id).token };
  const vars = { OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    PUBLIC_URL: 'https://notes.example', PASSWORD_LOGIN: passwordLogin };
  const fingerprint = verified ? settingsFingerprint(resolveAuthSettings(vars)) : '';
  const env = { auth: resolveAuthSettings({ ...vars, OIDC_VERIFIED: fingerprint }) };
  const oidc = createOidcService({ env, log: capture().log, discover: async () => { throw new Error('offline'); } });
  createWebServer({ db, users, oidc });
  return { users, tokens };
}

test('starting with password login already off (e.g. after a recovery) ends leftover password-only sessions', () => {
  const { users, tokens } = bootServer({ passwordLogin: 'false', verified: true });
  assert.equal(users.getSessionUser(tokens.jo), null);
  assert.equal(users.getSessionUser(tokens.sam).username, 'sam');
});

test('starting while password login is effectively on leaves every session alone', () => {
  for (const opts of [{ passwordLogin: 'true', verified: true }, { passwordLogin: 'false', verified: false }]) {
    const { users, tokens } = bootServer(opts);
    assert.equal(users.getSessionUser(tokens.jo).username, 'jo', JSON.stringify(opts));
    assert.equal(users.getSessionUser(tokens.sam).username, 'sam', JSON.stringify(opts));
  }
});

test('without a group allowlist, auto-create is off: unknown identities get no_account', async (t) => {
  const ctx = await setup(t, { auth: { OIDC_ALLOWED_GROUPS: '', OIDC_AUTO_CREATE: 'true' } });
  const run = await signIn(ctx);
  assert.equal(run.location, '/?authError=no_account');
  assert.equal(run.session, null);
  assert.equal(ctx.users.countUsers(), 1);
});
