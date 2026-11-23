// test/auth-settings.test.js — SSO / password-login settings: env parsing,
// dashboard patch validation, merging and .env persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import dotenv from 'dotenv';
import { AUTH_DEFAULTS, resolveAuthSettings } from '../src/config/auth-settings.js';
import { config } from '../src/config/env.js';
import {
  normalizeAuthPatch, mergeAuthSettings, persistAuthSettings, ssoConfigProblem, redirectUriFor,
  settingsFingerprint, isSsoVerified, passwordLoginEffective, isHttpsUrl,
} from '../src/store/oidc-settings.js';

test('with no env, SSO is off and password login is on (defaults)', () => {
  const s = resolveAuthSettings({});
  assert.deepEqual(s, AUTH_DEFAULTS);
  assert.equal(s.enabled, false);
  assert.equal(s.passwordLogin, true);
  assert.equal(s.autoCreate, true);
  assert.equal(s.scopes, 'openid profile email');
  assert.equal(s.groupsClaim, 'groups');
  assert.equal(s.label, 'Sign in with SSO');
  assert.deepEqual(s.allowedGroups, []);
});

test('the app config carries auth settings resolved from the environment', () => {
  assert.equal(typeof config.auth, 'object');
  assert.equal(typeof config.auth.passwordLogin, 'boolean');
});

test('env values are parsed into typed settings', () => {
  const s = resolveAuthSettings({
    OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://auth.example.com/application/o/parley/', OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'sec', OIDC_SCOPES: ' openid  email ', OIDC_GROUPS_CLAIM: 'roles',
    OIDC_ALLOWED_GROUPS: 'staff, ops ,,staff', OIDC_ADMIN_GROUP: 'parley-admins', OIDC_AUTO_CREATE: 'false',
    OIDC_BUTTON_LABEL: 'Sign in with Authentik', PUBLIC_URL: 'https://notes.example.com//', PASSWORD_LOGIN: '0',
  });
  assert.equal(s.enabled, true);
  assert.equal(s.issuer, 'https://auth.example.com/application/o/parley/'); // trailing slash kept: must match exactly
  assert.equal(s.scopes, 'openid email');
  assert.equal(s.groupsClaim, 'roles');
  assert.deepEqual(s.allowedGroups, ['staff', 'ops']);
  assert.equal(s.adminGroup, 'parley-admins');
  assert.equal(s.autoCreate, false);
  assert.equal(s.label, 'Sign in with Authentik');
  assert.equal(s.publicUrl, 'https://notes.example.com');
  assert.equal(s.passwordLogin, false);
  assert.ok(Object.isFrozen(s));
});

test('unrecognised boolean env values fall back to the default', () => {
  const s = resolveAuthSettings({ OIDC_ENABLED: 'maybe', PASSWORD_LOGIN: 'nah', OIDC_AUTO_CREATE: '' });
  assert.equal(s.enabled, false);
  assert.equal(s.passwordLogin, true);
  assert.equal(s.autoCreate, true);
});

test('normalizeAuthPatch accepts a typed subset and maps names', () => {
  const patch = normalizeAuthPatch({
    ssoEnabled: true, issuer: ' https://auth.example.com/o/ ', clientId: ' cid ', clientSecret: 'sec',
    scopes: 'openid  profile', groupsClaim: '', allowedGroups: ['a', ' b '], adminGroup: 'admins',
    autoCreate: false, label: '', publicUrl: 'http://10.0.0.5:3000/', passwordLogin: true, unknown: 1,
  });
  assert.deepEqual(patch, {
    enabled: true, issuer: 'https://auth.example.com/o/', clientId: 'cid', clientSecret: 'sec',
    scopes: 'openid profile', groupsClaim: AUTH_DEFAULTS.groupsClaim, allowedGroups: ['a', 'b'], adminGroup: 'admins',
    autoCreate: false, label: AUTH_DEFAULTS.label, publicUrl: 'http://10.0.0.5:3000', passwordLogin: true,
  });
  assert.deepEqual(normalizeAuthPatch({ allowedGroups: 'x, y' }).allowedGroups, ['x', 'y']);
});

test('clientSecret: empty string leaves it unchanged, null clears it', () => {
  assert.equal('clientSecret' in normalizeAuthPatch({ clientSecret: '' }), false);
  assert.equal(normalizeAuthPatch({ clientSecret: null }).clientSecret, '');
});

test('normalizeAuthPatch rejects bad types and unsafe values with readable errors', () => {
  const bad = [
    [{ ssoEnabled: 'true' }, /ssoEnabled must be true or false/],
    [{ passwordLogin: 0 }, /passwordLogin must be true or false/],
    [{ issuer: 'ftp://auth.example.com' }, /http or https/],
    [{ issuer: 'not a url' }, /valid URL/],
    [{ issuer: 'https://user:pw@auth.example.com/' }, /credentials/],
    [{ issuer: 'http://169.254.169.254/' }, /blocked/],
    [{ issuer: 'https://auth.example.com/?x=1' }, /query/],
    [{ publicUrl: 'javascript:alert(1)' }, /http or https/],
    [{ publicUrl: 'https://a:b@notes.example.com' }, /credentials/],
    [{ scopes: 'profile email' }, /openid/],
    [{ scopes: 'openid "bad"' }, /scope/i],
    [{ clientId: 'a\nOIDC_ENABLED=true' }, /control characters/],
    [{ clientSecret: 42 }, /clientSecret/],
    [{ allowedGroups: ['ok', 'a,b'] }, /comma/],
    [{ allowedGroups: [1] }, /allowedGroups/],
    [{ label: 'x'.repeat(65) }, /at most/],
  ];
  for (const [body, re] of bad) {
    assert.throws(() => normalizeAuthPatch(body), re, JSON.stringify(body));
  }
});

test('private-network issuers are allowed (self-hosted Authentik on the LAN)', () => {
  assert.equal(normalizeAuthPatch({ issuer: 'http://192.168.1.20:9000/application/o/parley/' }).issuer,
    'http://192.168.1.20:9000/application/o/parley/');
  assert.equal(normalizeAuthPatch({ issuer: 'http://localhost:9000/' }).issuer, 'http://localhost:9000/');
});

test('mergeAuthSettings returns a new frozen object and leaves the original alone', () => {
  const current = resolveAuthSettings({});
  const next = mergeAuthSettings(current, { enabled: true, issuer: 'https://a/' });
  assert.notEqual(next, current);
  assert.equal(current.enabled, false);
  assert.equal(next.enabled, true);
  assert.equal(next.issuer, 'https://a/');
  assert.ok(Object.isFrozen(next));
});

test('ssoConfigProblem names what is missing before SSO can be used', () => {
  const base = { ...AUTH_DEFAULTS, enabled: true };
  assert.match(ssoConfigProblem(base), /issuer/i);
  assert.match(ssoConfigProblem({ ...base, issuer: 'https://a/' }), /client id/i);
  assert.match(ssoConfigProblem({ ...base, issuer: 'https://a/', clientId: 'c' }), /client secret/i);
  assert.match(ssoConfigProblem({ ...base, issuer: 'https://a/', clientId: 'c', clientSecret: 's' }), /PUBLIC_URL|public URL/i);
  assert.equal(ssoConfigProblem({ ...base, issuer: 'https://a/', clientId: 'c', clientSecret: 's', publicUrl: 'https://n' }), null);
  assert.match(ssoConfigProblem({ ...base, issuer: 'https://a/', clientId: 'c', clientSecret: 's', publicUrl: 'notaurl' }), /public URL/i);
});

test('redirectUriFor builds the callback from PUBLIC_URL only', () => {
  assert.equal(redirectUriFor({ publicUrl: 'https://notes.example.com' }), 'https://notes.example.com/api/auth/oidc/callback');
  assert.equal(redirectUriFor({ publicUrl: '' }), '');
});

test('persistAuthSettings writes changed keys in one round-trippable .env update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-auth-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=x\nOIDC_CLIENT_SECRET=old\n');
  const current = resolveAuthSettings({ OIDC_CLIENT_SECRET: 'old' });
  const next = mergeAuthSettings(current, {
    enabled: true, issuer: 'https://auth.example.com/application/o/parley/', clientId: 'cid', clientSecret: '',
    scopes: 'openid profile email groups', allowedGroups: ['staff', 'ops'], label: "Sign in with Bob's IdP",
    publicUrl: 'https://notes.example.com', passwordLogin: false, autoCreate: false,
  });

  await persistAuthSettings(current, next, { envPath });

  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /^DISCORD_TOKEN=x$/m);
  assert.doesNotMatch(text, /OIDC_CLIENT_SECRET/); // cleared → removed
  for (const parsed of [parseEnv(text), dotenv.parse(text)]) {
    const back = resolveAuthSettings(parsed);
    assert.deepEqual({ ...back }, { ...next });
  }
});

test('persistAuthSettings leaves the file alone when nothing changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-auth-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'KEEP=1\n');
  const s = resolveAuthSettings({});
  await persistAuthSettings(s, mergeAuthSettings(s, {}), { envPath });
  assert.equal(readFileSync(envPath, 'utf8'), 'KEEP=1\n');
});

// ── Verified marker (OIDC_VERIFIED) ──────────────────────────────────────────

const SSO = resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c',
  OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://notes.example', PASSWORD_LOGIN: 'false' });

test('settingsFingerprint tracks every sign-in setting but not the label or password login', () => {
  const fp = settingsFingerprint(SSO);
  assert.match(fp, /^[0-9a-f]{64}$/);
  const changes = { enabled: false, issuer: 'https://other/', clientId: 'x', clientSecret: 'y', publicUrl: 'https://p',
    scopes: 'openid', groupsClaim: 'roles', allowedGroups: ['a'], adminGroup: 'g', autoCreate: false };
  for (const [k, v] of Object.entries(changes)) {
    assert.notEqual(settingsFingerprint({ ...SSO, [k]: v }), fp, k);
  }
  assert.equal(settingsFingerprint({ ...SSO, label: 'Other', passwordLogin: true }), fp);
});

test('isSsoVerified needs SSO on and a marker for exactly the current settings', () => {
  assert.equal(isSsoVerified(SSO), false);
  const verified = { ...SSO, verifiedFingerprint: settingsFingerprint(SSO) };
  assert.equal(isSsoVerified(verified), true);
  assert.equal(isSsoVerified({ ...verified, clientSecret: 'rotated' }), false);
  assert.equal(isSsoVerified({ ...verified, enabled: false }), false);
});

test('effective password login is off only when configured off, SSO on and verified', () => {
  const verified = { ...SSO, verifiedFingerprint: settingsFingerprint(SSO) };
  assert.equal(passwordLoginEffective(SSO), true); // not verified yet
  assert.equal(passwordLoginEffective(verified), false);
  assert.equal(passwordLoginEffective({ ...verified, passwordLogin: true }), true);
  assert.equal(passwordLoginEffective(resolveAuthSettings({ PASSWORD_LOGIN: 'false' })), true); // SSO off
});

test('OIDC_VERIFIED is read from the environment', () => {
  const fp = settingsFingerprint(SSO);
  const env = { OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    PUBLIC_URL: 'https://notes.example', PASSWORD_LOGIN: 'false', OIDC_VERIFIED: fp };
  assert.equal(isSsoVerified(resolveAuthSettings(env)), true);
  assert.equal(AUTH_DEFAULTS.verifiedFingerprint, '');
});

test('mergeAuthSettings clears the marker when a sign-in setting changes, and keeps it otherwise', () => {
  const verified = mergeAuthSettings(SSO, { verifiedFingerprint: settingsFingerprint(SSO) });
  assert.equal(isSsoVerified(verified), true);
  assert.equal(mergeAuthSettings(verified, { label: 'New label', passwordLogin: true }).verifiedFingerprint, verified.verifiedFingerprint);
  assert.equal(mergeAuthSettings(verified, { allowedGroups: ['x'] }).verifiedFingerprint, '');
  assert.equal(mergeAuthSettings(verified, { clientSecret: 'new' }).verifiedFingerprint, '');
});

test('the marker is never accepted from a dashboard patch', () => {
  assert.equal('verifiedFingerprint' in normalizeAuthPatch({ verifiedFingerprint: 'x', OIDC_VERIFIED: 'y', label: 'L' }), false);
});

test('ssoConfigProblem refuses a link-local / metadata issuer, also when it came from the environment', () => {
  const blocked = resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'http://169.254.169.254/latest/', OIDC_CLIENT_ID: 'c',
    OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' });
  assert.match(ssoConfigProblem(blocked), /blocked/);
});

test('isHttpsUrl recognises an https PUBLIC_URL', () => {
  assert.equal(isHttpsUrl('https://notes.example.com'), true);
  assert.equal(isHttpsUrl('http://10.0.0.5:3000'), false);
  assert.equal(isHttpsUrl(''), false);
});
