// test/auth-settings-routes.test.js — GET/PUT /api/system/auth: the admin view
// of SSO + password-login settings, validation, discovery before saving,
// persistence to .env, live apply and the no-lockout guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { installUsers } from '../src/store/users.js';
import { createWebServer } from '../src/web/server.js';
import { resolveAuthSettings } from '../src/config/auth-settings.js';
import { createOidcService } from '../src/web/oidc-service.js';
import { startFakeProvider } from './helpers/fake-oidc-provider.js';

const quiet = { info() {}, warn() {}, error() {} };
const pair = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? null;

async function setup(t, envVars = {}) {
  const provider = await startFakeProvider();
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.setPassword(users.getUserByUsername('admin').id, 'admin-pass-1');
  const envPath = join(mkdtempSync(join(tmpdir(), 'parley-auth-routes-')), '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=keep-me\n');
  const env = { auth: resolveAuthSettings(envVars) };
  const oidc = createOidcService({ env, envPath, log: quiet });
  const server = createWebServer({ db, users, oidc }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await provider.close(); });
  const login = async (username, password) => pair(await send(base, 'POST', '/api/auth/login', { username, password }), 'parley_session');
  return { provider, users, env, envPath, oidc, base, login, admin: await login('admin', 'admin-pass-1') };
}

function send(base, method, path, body, cookie) {
  return fetch(`${base}${path}`, { method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const enableBody = (ctx, extra = {}) => ({ ssoEnabled: true, issuer: ctx.provider.issuer, clientId: ctx.provider.clientId,
  clientSecret: ctx.provider.clientSecret, publicUrl: ctx.base, ...extra });

// Complete an SSO sign-in in this "browser" and return the session cookie.
async function ssoSignIn(base) {
  const login = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
  const flow = pair(login, 'parley_oidc');
  const cb = (await fetch(login.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  return pair(await fetch(cb, { redirect: 'manual', headers: { cookie: flow } }), 'parley_session');
}

test('GET /system/auth shows the settings to admins, without the client secret', async (t) => {
  const ctx = await setup(t, { OIDC_CLIENT_SECRET: 'never-shown', OIDC_ALLOWED_GROUPS: 'a,b' });
  const res = await send(ctx.base, 'GET', '/api/system/auth', undefined, ctx.admin);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes('never-shown'), false);
  const body = JSON.parse(text);
  assert.deepEqual(body.sso, {
    enabled: false, issuer: '', clientId: '', clientSecretSet: true, scopes: 'openid profile email', groupsClaim: 'groups',
    allowedGroups: ['a', 'b'], adminGroup: '', autoCreate: true, label: 'Sign in with SSO', status: 'off', error: null,
  });
  assert.equal(body.passwordLogin, true);
  assert.equal(body.passwordLoginEffective, true);
  assert.equal(body.ssoVerified, false);
  assert.equal(body.publicUrl, '');
  assert.equal(body.redirectUri, '');
  assert.equal(JSON.stringify(body).includes('verifiedFingerprint'), false);
});

test('the auth settings routes are admin-only and need a changed default password', async (t) => {
  const ctx = await setup(t);
  assert.equal((await send(ctx.base, 'GET', '/api/system/auth')).status, 401);
  ctx.users.createUser({ username: 'jo', password: 'pw123456' });
  const jo = await ctx.login('jo', 'pw123456');
  assert.equal((await send(ctx.base, 'GET', '/api/system/auth', undefined, jo)).status, 403);
  assert.equal((await send(ctx.base, 'PUT', '/api/system/auth', { label: 'x' }, jo)).status, 403);
  ctx.users.createUser({ username: 'fresh', password: 'pw123456', isAdmin: true, mustChangePassword: true });
  const fresh = await ctx.login('fresh', 'pw123456');
  const gated = await send(ctx.base, 'PUT', '/api/system/auth', { label: 'x' }, fresh);
  assert.equal(gated.status, 403);
  assert.equal((await gated.json()).code, 'PASSWORD_CHANGE_REQUIRED');
});

test('PUT rejects invalid values and unknown-only bodies without touching .env', async (t) => {
  const ctx = await setup(t);
  for (const body of [{ issuer: 'ftp://x' }, { ssoEnabled: 'yes' }, { publicUrl: 'https://u:p@x.example' }, { scopes: 'email' }, { nope: 1 }]) {
    const res = await send(ctx.base, 'PUT', '/api/system/auth', body, ctx.admin);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof (await res.json()).error, 'string');
  }
  assert.equal(readFileSync(ctx.envPath, 'utf8'), 'DISCORD_TOKEN=keep-me\n');
});

test('enabling SSO runs discovery first; a failure is a readable 400 and nothing is saved', async (t) => {
  const ctx = await setup(t);
  const wrongIssuer = await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx, { issuer: `${ctx.provider.base}/nope/` }), ctx.admin);
  assert.equal(wrongIssuer.status, 400);
  assert.match((await wrongIssuer.json()).error, /HTTP 404/);
  const missing = await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx, { publicUrl: '' }), ctx.admin);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /public URL/i);
  assert.equal(readFileSync(ctx.envPath, 'utf8'), 'DISCORD_TOKEN=keep-me\n');
  assert.equal(ctx.env.auth.enabled, false);
});

test('enabling SSO persists to .env, applies live and returns the GET shape', async (t) => {
  const ctx = await setup(t);
  const res = await send(ctx.base, 'PUT', '/api/system/auth',
    enableBody(ctx, { allowedGroups: ['staff'], adminGroup: 'admins', label: 'Sign in with Authentik' }), ctx.admin);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(ctx.provider.clientSecret), false);
  const body = JSON.parse(text);
  assert.equal(body.sso.enabled, true);
  assert.equal(body.sso.status, 'ok');
  assert.equal(body.sso.error, null);
  assert.equal(body.sso.clientSecretSet, true);
  assert.deepEqual(body.sso.allowedGroups, ['staff']);
  assert.equal(body.redirectUri, `${ctx.base}/api/auth/oidc/callback`);

  const file = readFileSync(ctx.envPath, 'utf8');
  assert.match(file, /^DISCORD_TOKEN=keep-me$/m);
  assert.match(file, /^OIDC_ENABLED=true$/m);
  assert.match(file, new RegExp(`^OIDC_CLIENT_SECRET=${ctx.provider.clientSecret}$`, 'm'));
  assert.match(file, /^OIDC_BUTTON_LABEL='Sign in with Authentik'$/m);
  assert.match(file, new RegExp(`^PUBLIC_URL=${ctx.base.replace(/[.]/g, '\\.')}$`, 'm'));

  const me = await (await fetch(`${ctx.base}/api/auth/me`)).json();
  assert.deepEqual(me.sso, { enabled: true, label: 'Sign in with Authentik' });
  assert.equal(await ssoSignIn(ctx.base), null, 'the new allowlist applies immediately');
  ctx.provider.user = { ...ctx.provider.user, groups: ['staff'] };
  assert.ok(await ssoSignIn(ctx.base), 'the new settings work immediately');
});

test('clientSecret: "" keeps the stored secret, null clears it', async (t) => {
  const ctx = await setup(t, { OIDC_CLIENT_SECRET: 'old-secret' });
  assert.equal((await send(ctx.base, 'PUT', '/api/system/auth', { clientSecret: '', label: 'L' }, ctx.admin)).status, 200);
  assert.equal(ctx.env.auth.clientSecret, 'old-secret');
  const cleared = await (await send(ctx.base, 'PUT', '/api/system/auth', { clientSecret: null }, ctx.admin)).json();
  assert.equal(cleared.sso.clientSecretSet, false);
  assert.equal(ctx.env.auth.clientSecret, '');
  assert.doesNotMatch(readFileSync(ctx.envPath, 'utf8'), /OIDC_CLIENT_SECRET/);
});

test('password login cannot be turned off while SSO is off', async (t) => {
  const ctx = await setup(t);
  const res = await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: false }, ctx.admin);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /single sign-on/i);
  assert.equal(ctx.env.auth.passwordLogin, true);
});

test('password login cannot be turned off by an admin who has never signed in with SSO', async (t) => {
  const ctx = await setup(t);
  assert.equal((await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx), ctx.admin)).status, 200);
  const res = await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: false }, ctx.admin);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /lock yourself out/i);
  assert.equal(ctx.env.auth.passwordLogin, true);
  assert.doesNotMatch(readFileSync(ctx.envPath, 'utf8'), /PASSWORD_LOGIN/);
});

test('an SSO-linked admin can turn password login off; it bites once verified, and provider changes un-verify', async (t) => {
  const ctx = await setup(t);
  await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx, { adminGroup: 'admins' }), ctx.admin);
  ctx.provider.user = { ...ctx.provider.user, groups: ['admins'] };
  const ssoAdmin = await ssoSignIn(ctx.base); // an admin SSO sign-in verifies the current settings
  const res = await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: false }, ssoAdmin);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.passwordLogin, false);
  assert.equal(body.passwordLoginEffective, false);
  assert.equal(body.ssoVerified, true);
  const file = readFileSync(ctx.envPath, 'utf8');
  assert.match(file, /^PASSWORD_LOGIN=false$/m);
  assert.match(file, /^OIDC_VERIFIED=[0-9a-f]{64}$/m);
  const login = await send(ctx.base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-1' });
  assert.equal(login.status, 403);
  assert.equal((await (await fetch(`${ctx.base}/api/auth/me`)).json()).passwordLogin, false);

  // Cosmetic changes keep the verification.
  const label = await (await send(ctx.base, 'PUT', '/api/system/auth', { label: 'Company login' }, ssoAdmin)).json();
  assert.equal(label.ssoVerified, true);
  // Switching provider is allowed but un-verifies, so password login is effectively back on.
  const other = await startFakeProvider();
  t.after(() => other.close());
  const moved = await send(ctx.base, 'PUT', '/api/system/auth',
    { issuer: other.issuer, clientId: other.clientId, clientSecret: other.clientSecret }, ssoAdmin);
  assert.equal(moved.status, 200);
  const after = await moved.json();
  assert.equal(after.passwordLogin, false);
  assert.equal(after.ssoVerified, false);
  assert.equal(after.passwordLoginEffective, true);
  assert.doesNotMatch(readFileSync(ctx.envPath, 'utf8'), /OIDC_VERIFIED/);
  assert.equal((await send(ctx.base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-1' })).status, 200);
});

test('turning password login off revokes password-only sessions, except the acting admin', async (t) => {
  const ctx = await setup(t);
  await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx, { adminGroup: 'admins' }), ctx.admin);
  ctx.users.createUser({ username: 'jo', password: 'pw123456' });
  const jo = await ctx.login('jo', 'pw123456');
  ctx.provider.user = { ...ctx.provider.user, groups: ['admins'] };
  const ssoAdmin = await ssoSignIn(ctx.base); // verified; password login still configured on
  assert.equal((await send(ctx.base, 'GET', '/api/auth/me', undefined, jo).then((r) => r.json())).user.username, 'jo');
  assert.equal((await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: false }, ssoAdmin)).status, 200);
  assert.equal((await send(ctx.base, 'GET', '/api/auth/me', undefined, jo).then((r) => r.json())).user, null);
  assert.equal((await send(ctx.base, 'GET', '/api/auth/me', undefined, ctx.admin).then((r) => r.json())).user, null);
  assert.equal((await send(ctx.base, 'GET', '/api/auth/me', undefined, ssoAdmin).then((r) => r.json())).user.username, 'jane');
});

test('concurrent PUTs are serialized, so neither change is lost', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await Promise.all([
    send(ctx.base, 'PUT', '/api/system/auth', { label: 'Company login' }, ctx.admin),
    send(ctx.base, 'PUT', '/api/system/auth', { adminGroup: 'parley-admins' }, ctx.admin),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(ctx.env.auth.label, 'Company login');
  assert.equal(ctx.env.auth.adminGroup, 'parley-admins');
  const file = readFileSync(ctx.envPath, 'utf8');
  assert.match(file, /^OIDC_BUTTON_LABEL='Company login'$/m);
  assert.match(file, /^OIDC_ADMIN_GROUP=parley-admins$/m);
});

test('password login can be turned back on while the provider is down (no discovery needed)', async (t) => {
  const ctx = await setup(t);
  await send(ctx.base, 'PUT', '/api/system/auth', enableBody(ctx, { adminGroup: 'admins' }), ctx.admin);
  ctx.provider.user = { ...ctx.provider.user, groups: ['admins'] };
  const ssoAdmin = await ssoSignIn(ctx.base);
  assert.equal((await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: false }, ssoAdmin)).status, 200);
  await ctx.provider.close(); // the identity provider goes away
  const discoveries = ctx.provider.requests.discovery;

  const label = await send(ctx.base, 'PUT', '/api/system/auth', { label: 'Back soon' }, ssoAdmin);
  assert.equal(label.status, 200);
  const res = await send(ctx.base, 'PUT', '/api/system/auth', { passwordLogin: true }, ssoAdmin);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).passwordLogin, true);
  assert.equal(ctx.provider.requests.discovery, discoveries);
  assert.equal((await send(ctx.base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-1' })).status, 200);
});
