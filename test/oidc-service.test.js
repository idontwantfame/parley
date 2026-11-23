// test/oidc-service.test.js — provider discovery, caching, health status and
// the password-login fallback rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthSettings } from '../src/config/auth-settings.js';
import { settingsFingerprint } from '../src/store/oidc-settings.js';
import { createOidcService } from '../src/web/oidc-service.js';
import { startFakeProvider } from './helpers/fake-oidc-provider.js';

function capture() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: { info: push, warn: push, error: push } };
}

function ssoEnv(provider, extra = {}) {
  return {
    auth: resolveAuthSettings({
      OIDC_ENABLED: 'true', OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret, PUBLIC_URL: 'http://127.0.0.1:1', ...extra,
    }),
  };
}

async function closedPort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('with SSO off: status off, no discovery, password login on', async () => {
  let calls = 0;
  const oidc = createOidcService({ env: { auth: resolveAuthSettings({ PASSWORD_LOGIN: 'false' }) },
    discover: async () => { calls += 1; }, log: capture().log });
  assert.deepEqual(oidc.status(), { status: 'off', error: null });
  assert.equal(await oidc.ensure(), null);
  assert.equal(calls, 0);
  assert.equal(oidc.ready(), false);
  assert.deepEqual(oidc.publicInfo(), { enabled: false, label: 'Sign in with SSO' });
  assert.equal(oidc.passwordLoginEnabled(), true); // PASSWORD_LOGIN=false is ignored while SSO is not working
});

test('incomplete settings report a readable error without contacting anyone', async () => {
  let calls = 0;
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/' }) };
  const oidc = createOidcService({ env, discover: async () => { calls += 1; }, log: capture().log });
  assert.equal(await oidc.ensure(), null);
  assert.equal(calls, 0);
  const { status, error } = oidc.status();
  assert.equal(status, 'error');
  assert.match(error, /client ID/);
});

test('discovery against a real-shaped provider succeeds and SSO becomes ready', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  const oidc = createOidcService({ env: ssoEnv(provider, { PASSWORD_LOGIN: 'false' }), log: capture().log });
  const configuration = await oidc.ensure();
  assert.ok(configuration);
  assert.equal(configuration.serverMetadata().issuer, provider.issuer);
  assert.deepEqual(oidc.status(), { status: 'ok', error: null });
  assert.equal(oidc.ready(), true);
  assert.deepEqual(oidc.publicInfo(), { enabled: true, label: 'Sign in with SSO' });
  // PASSWORD_LOGIN=false only bites once an admin SSO sign-in verified these settings.
  assert.equal(oidc.passwordLoginEnabled(), true);
  // Cached: a second ensure does not re-discover.
  await oidc.ensure();
  assert.equal(provider.requests.discovery, 1);
});

test('an unreachable provider is reported, logged without secrets, and password login stays on', async () => {
  const port = await closedPort();
  const { lines, log } = capture();
  const env = { auth: resolveAuthSettings({
    OIDC_ENABLED: 'true', OIDC_ISSUER: `http://127.0.0.1:${port}/application/o/parley/`, OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'very-secret-value', PUBLIC_URL: 'http://127.0.0.1:1', PASSWORD_LOGIN: 'false' }) };
  const oidc = createOidcService({ env, log });
  assert.equal(await oidc.start(), null);
  const { status, error } = oidc.status();
  assert.equal(status, 'error');
  assert.match(error, /could not reach/i);
  assert.equal(oidc.passwordLoginEnabled(), true); // never verified
  assert.ok(lines.some((l) => /PASSWORD_LOGIN=false/.test(l)), 'warns that password login stays on');
  assert.equal(lines.some((l) => l.includes('very-secret-value')), false);
});

test('an issuer that does not match the provider names the issuer to use', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  const env = ssoEnv(provider, { OIDC_ISSUER: provider.issuer.replace(/\/$/, '') }); // missing trailing slash
  const oidc = createOidcService({ env, log: capture().log });
  assert.equal(await oidc.ensure(), null);
  assert.match(oidc.status().error, new RegExp(`issuer.*${provider.issuer.replace(/[/.]/g, '\\$&')}`));
});

test('a provider that only signs with a shared secret (HS256) is refused with a hint', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  provider.algs = ['HS256'];
  const oidc = createOidcService({ env: ssoEnv(provider), log: capture().log });
  assert.equal(await oidc.ensure(), null);
  assert.match(oidc.status().error, /signing key/i);
});

test('a failed discovery is retried only after the retry interval', async () => {
  let t = 0;
  let calls = 0;
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' }) };
  const oidc = createOidcService({ env, now: () => t, retryMs: 1000, log: capture().log,
    discover: async () => { calls += 1; throw new Error('boom'); } });
  await oidc.ensure();
  await oidc.ensure();
  assert.equal(calls, 1);
  t = 1001;
  await oidc.ensure();
  assert.equal(calls, 2);
});

test('concurrent ensure calls share one discovery', async () => {
  let calls = 0;
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' }) };
  const fake = { serverMetadata: () => ({}) };
  const oidc = createOidcService({ env, log: capture().log,
    discover: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return fake; } });
  const [a, b] = await Promise.all([oidc.ensure(), oidc.ensure()]);
  assert.equal(a, fake);
  assert.equal(b, fake);
  assert.equal(calls, 1);
});

test('changed settings trigger a fresh discovery', async () => {
  const seen = [];
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' }) };
  const oidc = createOidcService({ env, log: capture().log,
    discover: async (s) => { seen.push(s.clientId); return { serverMetadata: () => ({}) }; } });
  await oidc.ensure();
  env.auth = { ...env.auth, clientId: 'c2' };
  await oidc.ensure();
  assert.deepEqual(seen, ['c', 'c2']);
});

test('probe validates candidate settings without touching the live state', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  const env = { auth: resolveAuthSettings({}) };
  const oidc = createOidcService({ env, log: capture().log });
  const candidate = ssoEnv(provider).auth;
  assert.ok(await oidc.probe(candidate));
  await assert.rejects(oidc.probe({ ...candidate, issuer: `${provider.base}/nope/` }), /HTTP 404|discovery/i);
  await assert.rejects(oidc.probe({ ...candidate, clientSecret: '' }), /client secret/i);
  assert.deepEqual(oidc.status(), { status: 'off', error: null });
});

test('apply swaps in new settings and adopts an already-probed configuration', async () => {
  let calls = 0;
  const env = { auth: resolveAuthSettings({}) };
  const oidc = createOidcService({ env, log: capture().log, discover: async () => { calls += 1; return {}; } });
  const next = Object.freeze({ ...resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' }) });
  const configuration = { serverMetadata: () => ({}) };
  oidc.apply(next, configuration);
  assert.equal(env.auth, next);
  assert.equal(oidc.status().status, 'ok');
  assert.equal(await oidc.ensure(), configuration);
  assert.equal(calls, 0);
});

// ── Verified marker, outages, serialization, blocked endpoints ───────────────

const tmpEnv = () => join(mkdtempSync(join(tmpdir(), 'parley-svc-')), '.env');
const verifiedVars = (vars) => ({ ...vars, OIDC_VERIFIED: settingsFingerprint(resolveAuthSettings(vars)) });

test('once verified, a provider outage does not turn password login back on; the log says how to recover', async () => {
  const port = await closedPort();
  const { lines, log } = capture();
  const vars = { OIDC_ENABLED: 'true', OIDC_ISSUER: `http://127.0.0.1:${port}/application/o/parley/`, OIDC_CLIENT_ID: 'c',
    OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'http://127.0.0.1:1', PASSWORD_LOGIN: 'false' };
  const oidc = createOidcService({ env: { auth: resolveAuthSettings(verifiedVars(vars)) }, log });
  assert.equal(await oidc.ensure(), null);
  assert.equal(oidc.status().status, 'error');
  assert.equal(oidc.verified(), true); // not invalidated by the outage
  assert.equal(oidc.passwordLoginEnabled(), false);
  assert.ok(lines.some((l) => /PASSWORD_LOGIN=true/.test(l) && /restart/i.test(l)));
});

test('verify sets the marker for the settings the sign-in started under, persists it, and reports the switch-off', async () => {
  const envPath = tmpEnv();
  writeFileSync(envPath, 'KEEP=1\n');
  const vars = { OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    PUBLIC_URL: 'https://n.example', PASSWORD_LOGIN: 'false' };
  const env = { auth: resolveAuthSettings(vars) };
  const oidc = createOidcService({ env, envPath, log: capture().log });
  const stale = await oidc.verify('not-the-current-fingerprint');
  assert.deepEqual(stale, { turnedOff: false });
  assert.equal(oidc.verified(), false);

  const result = await oidc.verify(oidc.fingerprint());
  assert.deepEqual(result, { turnedOff: true });
  assert.equal(oidc.verified(), true);
  assert.equal(oidc.passwordLoginEnabled(), false);
  assert.match(readFileSync(envPath, 'utf8'), new RegExp(`^OIDC_VERIFIED=${oidc.fingerprint()}$`, 'm'));
  assert.deepEqual(await oidc.verify(oidc.fingerprint()), { turnedOff: false }); // already verified
});

test('commit persists and applies new settings and says whether password login just turned off', async () => {
  const envPath = tmpEnv();
  const vars = verifiedVars({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c',
    OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' });
  const env = { auth: resolveAuthSettings(vars) };
  const oidc = createOidcService({ env, envPath, log: capture().log });
  const current = oidc.settings();
  assert.deepEqual(await oidc.commit(current, { ...current, passwordLogin: false }), { turnedOff: true });
  assert.equal(env.auth.passwordLogin, false);
  assert.match(readFileSync(envPath, 'utf8'), /^PASSWORD_LOGIN=false$/m);
  assert.deepEqual(await oidc.commit(oidc.settings(), { ...oidc.settings(), label: 'x' }), { turnedOff: false });
});

test('serialize runs tasks one at a time, in order, even after a failure', async () => {
  const oidc = createOidcService({ env: { auth: resolveAuthSettings({}) }, log: capture().log });
  const order = [];
  const task = (name, ms, fail) => () => new Promise((resolve, reject) => {
    order.push(`start ${name}`);
    setTimeout(() => { order.push(`end ${name}`); (fail ? reject(new Error(name)) : resolve(name)); }, ms);
  });
  const results = await Promise.allSettled([oidc.serialize(task('a', 20, true)), oidc.serialize(task('b', 1))]);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].value, 'b');
});

test('a provider whose server-side endpoints point at blocked addresses is refused', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  for (const field of ['token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'end_session_endpoint']) {
    provider.metadata = { [field]: 'http://169.254.169.254/latest/meta-data/' };
    const oidc = createOidcService({ env: ssoEnv(provider), log: capture().log });
    assert.equal(await oidc.ensure(), null, field);
    assert.match(oidc.status().error, /blocked/, field);
  }
});

test('an env-configured issuer on a blocked address is refused without any request', async () => {
  let calls = 0;
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: 'http://[fe80::1]/', OIDC_CLIENT_ID: 'c',
    OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'https://n.example' }) };
  const oidc = createOidcService({ env, log: capture().log, discover: async () => { calls += 1; } });
  oidc.start();
  assert.equal(await oidc.ensure(), null);
  assert.equal(calls, 0);
  assert.match(oidc.status().error, /blocked/);
});

test('every provider request goes through a fetch that refuses blocked hosts', async () => {
  const { guardedFetch } = await import('../src/web/oidc-service.js');
  await assert.rejects(guardedFetch('http://169.254.169.254/x', {}), /blocked/);
  await assert.rejects(guardedFetch(new URL('http://[::ffff:169.254.169.254]/'), {}), /blocked/);
});

test('the discovered configuration keeps the guarded fetch for its token, userinfo and JWKS requests', async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());
  const client = await import('openid-client');
  const { guardedFetch } = await import('../src/web/oidc-service.js');
  const configuration = await createOidcService({ env: ssoEnv(provider), log: capture().log }).ensure();
  assert.ok(configuration);
  assert.equal(configuration[client.customFetch], guardedFetch);
});

test('a provider redirect is never followed (so it cannot bounce requests to another host)', async (t) => {
  let followed = 0;
  let redirected = 0;
  const listen = async (handler) => {
    const srv = createHttpServer(handler).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    t.after(() => srv.close());
    return srv.address().port;
  };
  const target = await listen((_req, res) => { followed += 1; res.end('{}'); });
  const redirector = await listen((_req, res) => {
    redirected += 1;
    res.writeHead(302, { location: `http://127.0.0.1:${target}/.well-known/openid-configuration` });
    res.end();
  });
  const env = { auth: resolveAuthSettings({ OIDC_ENABLED: 'true', OIDC_ISSUER: `http://127.0.0.1:${redirector}/`,
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'http://127.0.0.1:1' }) };
  const oidc = createOidcService({ env, log: capture().log });
  assert.equal(await oidc.ensure(), null);
  assert.equal(oidc.status().status, 'error');
  assert.equal(redirected, 1);
  assert.equal(followed, 0);
});

test('provider requests are refused when the host name resolves to a blocked address', async () => {
  const { createGuardedFetch } = await import('../src/web/oidc-discovery.js');
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return new Response('{}'); };
  const toMetadata = createGuardedFetch({ fetchImpl, lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
  await assert.rejects(toMetadata('https://idp.example/.well-known/openid-configuration', {}), /blocked/);
  assert.equal(fetched, 0);
  const toLan = createGuardedFetch({ fetchImpl, lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
  await toLan('https://idp.example/token', {});
  assert.equal(fetched, 1);
});
