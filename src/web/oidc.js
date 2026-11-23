// src/web/oidc.js
// OpenID Connect single sign-on routes (public, mounted before the auth gate):
//
//   GET /api/auth/oidc/login?returnTo=/path → 302 to the provider
//   GET /api/auth/oidc/callback             → 302 to returnTo with a session,
//                                             or to /?authError=<code>
//
// Authorization code flow with PKCE (S256), state and nonce; the ID token
// (signature via JWKS, iss, aud, exp, nonce) is validated by openid-client.
// The flow's secrets stay server-side (oidc-flows.js) behind a short-lived
// cookie scoped to /api/auth/oidc, which binds the callback to the browser
// that started it; a callback whose state does not match leaves the flow (and
// its cookie) alone. Starting logins is rate limited per client IP. The
// redirect URI comes from PUBLIC_URL, never from Host. Failures are logged
// server-side; the browser only ever sees an error code. An admin's successful
// sign-in marks the current settings verified (see oidc-service.js).

import { Router } from 'express';
import * as client from 'openid-client';
import { createFixedWindowLimiter, createFlowStore, FLOW_TTL_MS, safeReturnTo } from './oidc-flows.js';
import { profileFromClaims, resolveSsoAccount } from './oidc-accounts.js';
import { clearCookie, readCookie, setCookie, setSessionCookie } from './cookies.js';
import { isHttpsUrl, redirectUriFor, settingsFingerprint } from '../store/oidc-settings.js';

const FLOW_COOKIE = 'parley_oidc';
const FLOW_COOKIE_PATH = '/api/auth/oidc';
const MAX_LOGGED = 300;
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITED_TEXT = 'Too many sign-in attempts. Try again in a few minutes.';

class SignInError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Name, code, the immediate cause's message (e.g. "JWT signature verification
// failed") and the provider's own error fields only: never the rest of the
// cause chain, which can carry response bodies or claims.
function describeFailure(err) {
  const cause = err?.cause instanceof Error ? err.cause.message : undefined;
  const parts = [err?.name ?? 'Error', err?.code, err?.message, cause, err?.error, err?.error_description];
  return parts.filter((p) => typeof p === 'string' && p).join(' | ').slice(0, MAX_LOGGED);
}

function failTo(res, code) {
  res.redirect(302, `/?authError=${code}`);
}

const secureFor = (req, settings) => req.secure || isHttpsUrl(settings.publicUrl);

// The URL the provider sent the browser to, rebuilt on the registered redirect
// URI (PUBLIC_URL) with the request's own query string.
function callbackUrl(flow, req) {
  const url = new URL(flow.redirectUri);
  url.search = new URL(req.originalUrl, 'http://callback.invalid').search;
  return url;
}

async function startLogin(req, res, { oidc, flows }) {
  const configuration = await oidc.ensure();
  if (!configuration) return failTo(res, 'provider_error');
  const settings = oidc.settings();
  const flow = {
    codeVerifier: client.randomPKCECodeVerifier(),
    state: client.randomState(),
    nonce: client.randomNonce(),
    returnTo: safeReturnTo(req.query.returnTo),
    redirectUri: redirectUriFor(settings),
    fingerprint: settingsFingerprint(settings), // the settings this sign-in can verify
  };
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: flow.redirectUri,
    scope: settings.scopes,
    code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
    code_challenge_method: 'S256',
    state: flow.state,
    nonce: flow.nonce,
  });
  setCookie(res, FLOW_COOKIE, flows.put(flow, req.ip ?? ''),
    { path: FLOW_COOKIE_PATH, maxAgeSec: FLOW_TTL_MS / 1000, secure: secureFor(req, settings) });
  res.redirect(302, url.href);
}

// ID token claims, topped up from userinfo when the groups claim is missing
// (some providers only put groups there). If groups decide access or admin
// status and userinfo fails, the sign-in fails closed.
async function signedInClaims(configuration, tokens, settings, log) {
  const claims = tokens.claims();
  if (claims[settings.groupsClaim] !== undefined) return claims;
  try {
    const userinfo = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);
    return { ...userinfo, ...claims };
  } catch (err) {
    if (settings.allowedGroups.length || settings.adminGroup) throw err;
    log.warn(`[oidc] userinfo unavailable, continuing without groups: ${describeFailure(err)}`);
    return claims;
  }
}

async function finishLogin(req, res, flow, { users, oidc, log }) {
  const configuration = await oidc.ensure();
  if (!configuration) throw new SignInError('provider_error', 'provider not available');
  const settings = oidc.settings();
  const tokens = await client.authorizationCodeGrant(configuration, callbackUrl(flow, req), {
    pkceCodeVerifier: flow.codeVerifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
  });
  const claims = await signedInClaims(configuration, tokens, settings, log);
  const result = resolveSsoAccount({ users, settings, log, profile: profileFromClaims(claims, settings.groupsClaim) });
  if (result.error) throw new SignInError(result.error, `account rules refused the sign-in (${result.error})`);
  if (result.user.isAdmin) await recordAdminSignIn(result.user, flow, { users, oidc, log });
  if (req.sessionToken) users.deleteSession(req.sessionToken); // no session reuse across identities
  const { token, expiresAt } = users.createSession(result.user.id);
  setSessionCookie(res, token, expiresAt, secureFor(req, settings));
  log.info?.(`[oidc] "${result.user.username}" signed in with single sign-on.`);
  res.redirect(302, flow.returnTo);
}

// An admin proved these settings work: mark them verified. If that switches
// password sign-in off, end the sessions of accounts that cannot use SSO.
// A failure here never blocks the sign-in itself (password login stays on).
async function recordAdminSignIn(user, flow, { users, oidc, log }) {
  try {
    const { turnedOff } = await oidc.verify(flow.fingerprint);
    if (turnedOff) users.revokePasswordOnlySessions(user.id);
  } catch (err) {
    log.warn(`[oidc] could not record the verified sign-in settings: ${describeFailure(err)}`);
  }
}

async function handleCallback(req, res, deps) {
  const settings = deps.oidc.settings();
  if (!settings.enabled) return failTo(res, 'sso_disabled');
  // Single use once the state matches. A mismatching (e.g. stray cross-site)
  // callback leaves the flow and its cookie alone, so it cannot cancel a
  // legitimate sign-in in progress.
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const flow = state ? deps.flows.take(readCookie(req, FLOW_COOKIE), (f) => f.state === state) : null;
  if (!flow) return failTo(res, 'state_mismatch');
  clearCookie(res, FLOW_COOKIE, { path: FLOW_COOKIE_PATH, secure: secureFor(req, settings) });
  try {
    await finishLogin(req, res, flow, deps);
  } catch (err) {
    const code = err instanceof SignInError ? err.code : 'provider_error';
    deps.log.warn(`[oidc] sign-in failed (${code}): ${describeFailure(err)}`);
    failTo(res, code);
  }
}

export function oidcRouter({
  users, oidc, flows = createFlowStore(), log = oidc.log ?? console,
  loginLimiter = createFixedWindowLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS }),
}) {
  const r = Router();
  const deps = { users, oidc, flows, log };

  r.get('/auth/oidc/login', async (req, res) => {
    if (!oidc.settings().enabled) return res.status(404).json({ error: 'Single sign-on is not enabled.' });
    const ip = req.ip ?? '';
    if (!loginLimiter.hit(ip)) {
      res.set('Retry-After', String(loginLimiter.retryAfterSec(ip)));
      return res.status(429).type('text/plain').send(RATE_LIMITED_TEXT);
    }
    try {
      await startLogin(req, res, deps);
    } catch (err) {
      log.warn(`[oidc] could not start sign-in: ${describeFailure(err)}`);
      failTo(res, 'provider_error');
    }
  });

  r.get('/auth/oidc/callback', (req, res) => handleCallback(req, res, deps));

  return r;
}
