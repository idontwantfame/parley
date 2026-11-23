// src/store/oidc-settings.js
// Validation, merging and .env persistence for the dashboard's sign-in settings
// (PUT /api/system/auth). Mirrors secrets.js: every value is validated first,
// then all changed keys are written to .env in one atomic persistEnv() call,
// then the caller swaps the new frozen settings object into config.auth.
//
// The client secret is write-only: it is never part of any response, and an
// empty string in a patch means "leave unchanged" (null clears it).
//
// Lock-out protection: PASSWORD_LOGIN=false only takes effect once the current
// sign-in settings are *verified* — an admin completed an SSO sign-in with
// them. OIDC_VERIFIED stores a fingerprint of those settings, so any change to
// them (or a hand edit of .env) un-verifies automatically. Recovery after a
// provider outage: set PASSWORD_LOGIN=true in .env and restart.

import { createHash } from 'node:crypto';
import { resolveEnvFile } from '../config/env.js';
import {
  AUTH_DEFAULTS, AUTH_ENV_KEYS, normalizeScopes, parseGroups, stripTrailingSlashes,
} from '../config/auth-settings.js';
import { formatEnvValue, isBlockedHost, persistEnv } from './secrets.js';

export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

const MAX_TEXT = 256;
const MAX_SECRET = 1024;
const MAX_LABEL = 64;
const MAX_CLAIM = 128;
const MAX_GROUPS = 100;
// RFC 6749 §3.3 scope-token characters.
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** A client-side mistake in a settings patch (the route maps it to a 400). */
export class AuthSettingsError extends Error {}
const fail = (message) => { throw new AuthSettingsError(message); };

function requireBool(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be true or false.`);
  return value;
}

// A trimmed string that can be written to .env (no control chars, no
// unquotable mix of quote characters) and is at most `max` characters long.
function requireText(value, name, max = MAX_TEXT) {
  if (typeof value !== 'string') fail(`${name} must be a string.`);
  const trimmed = value.trim();
  if (CONTROL_CHARS.test(trimmed)) fail(`${name} must not contain control characters.`);
  if (trimmed.length > max) fail(`${name} must be at most ${max} characters.`);
  try { formatEnvValue(trimmed); } catch { fail(`${name} cannot contain single quotes, double quotes and backticks together.`); }
  return trimmed;
}

// Parses an http(s) URL without credentials, query or fragment; throws a
// readable error naming `label` otherwise.
export function parseHttpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`${label} must use http or https.`);
  if (url.username || url.password) fail(`${label} must not contain credentials.`);
  if (url.search || url.hash) fail(`${label} must not contain a query or fragment.`);
  return url;
}

// Private-network issuers are fine (self-hosted Authentik on the LAN); only
// link-local / cloud-metadata targets are refused, as for the STT URL.
function issuerUrl(value) {
  const text = requireText(value, 'issuer');
  if (!text) return '';
  const url = parseHttpUrl(text, 'Issuer URL');
  if (isBlockedHost(url.hostname)) fail('Issuer URL points at a blocked address.');
  return text; // verbatim: discovery compares the issuer exactly (trailing slash included)
}

function publicUrl(value) {
  const text = requireText(value, 'publicUrl');
  if (!text) return '';
  parseHttpUrl(text, 'Public URL');
  return stripTrailingSlashes(text);
}

function scopes(value) {
  const list = normalizeScopes(requireText(value, 'scopes', 512)).split(' ').filter(Boolean);
  if (list.some((s) => !SCOPE_TOKEN.test(s))) fail('scopes contains a character that is not allowed in a scope.');
  if (!list.includes('openid')) fail('scopes must include "openid".');
  return list.join(' ');
}

function groups(value) {
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list) || list.some((g) => typeof g !== 'string')) {
    fail('allowedGroups must be a list of group names.');
  }
  if (list.some((g) => g.includes(','))) fail('Group names cannot contain a comma.');
  const parsed = parseGroups(list.map((g) => requireText(g, 'allowedGroups')));
  if (parsed.length > MAX_GROUPS) fail(`allowedGroups can list at most ${MAX_GROUPS} groups.`);
  return parsed;
}

const SKIP = Symbol('skip');
function clientSecret(value) {
  if (value === null) return ''; // clear
  const text = requireText(value, 'clientSecret', MAX_SECRET);
  return text || SKIP; // '' = leave unchanged
}

// request field -> [settings field, normalizer]
const FIELDS = {
  ssoEnabled: ['enabled', (v) => requireBool(v, 'ssoEnabled')],
  issuer: ['issuer', issuerUrl],
  clientId: ['clientId', (v) => requireText(v, 'clientId')],
  clientSecret: ['clientSecret', clientSecret],
  scopes: ['scopes', scopes],
  groupsClaim: ['groupsClaim', (v) => requireText(v, 'groupsClaim', MAX_CLAIM) || AUTH_DEFAULTS.groupsClaim],
  allowedGroups: ['allowedGroups', groups],
  adminGroup: ['adminGroup', (v) => requireText(v, 'adminGroup')],
  autoCreate: ['autoCreate', (v) => requireBool(v, 'autoCreate')],
  label: ['label', (v) => requireText(v, 'label', MAX_LABEL) || AUTH_DEFAULTS.label],
  publicUrl: ['publicUrl', publicUrl],
  passwordLogin: ['passwordLogin', (v) => requireBool(v, 'passwordLogin')],
};

/**
 * Validate a request body into a settings patch (settings field names). Only
 * known fields that are present are included; unknown ones are ignored.
 * Throws AuthSettingsError on the first invalid value.
 */
export function normalizeAuthPatch(body = {}) {
  const patch = {};
  for (const [field, [key, normalize]] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, field)) continue;
    const value = normalize(body[field]);
    if (value !== SKIP) patch[key] = value;
  }
  return patch;
}

// Every setting that decides who can sign in, and as whom.
const FINGERPRINT_FIELDS = ['enabled', 'issuer', 'clientId', 'clientSecret', 'publicUrl', 'scopes', 'groupsClaim',
  'allowedGroups', 'adminGroup', 'autoCreate'];

/** sha256 (hex) of the sign-in settings; the value OIDC_VERIFIED holds once verified. */
export function settingsFingerprint(settings) {
  const tuple = FINGERPRINT_FIELDS.map((k) => (Array.isArray(settings[k]) ? [...settings[k]] : settings[k]));
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

/** SSO is on and an admin has signed in with exactly these settings. */
export function isSsoVerified(settings) {
  return !!settings.enabled && !!settings.verifiedFingerprint
    && settings.verifiedFingerprint === settingsFingerprint(settings);
}

/** Password sign-in is off only when configured off AND SSO is on and verified. */
export function passwordLoginEffective(settings) {
  return settings.passwordLogin !== false || !isSsoVerified(settings);
}

export function isHttpsUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/**
 * New frozen settings = current + patch (current is never modified). A change
 * to any sign-in setting clears the verified marker.
 */
export function mergeAuthSettings(current, patch = {}) {
  const merged = { ...current, ...patch };
  const next = { ...merged, allowedGroups: parseGroups(merged.allowedGroups) };
  const unverify = settingsFingerprint(next) !== settingsFingerprint(current);
  return Object.freeze(unverify ? { ...next, verifiedFingerprint: '' } : next);
}

/** Why SSO cannot be used with these settings (readable), or null. */
export function ssoConfigProblem(settings) {
  if (!settings.issuer) return 'Set the issuer URL of your identity provider.';
  if (!settings.clientId) return 'Set the client ID.';
  if (!settings.clientSecret) return 'Set the client secret.';
  if (!settings.publicUrl) return 'Set the public URL (PUBLIC_URL) of the dashboard; the redirect URI is built from it.';
  try {
    // Also guards an issuer that came from the environment, not the dashboard.
    if (isBlockedHost(parseHttpUrl(settings.issuer, 'Issuer URL').hostname)) return 'Issuer URL points at a blocked address.';
    parseHttpUrl(settings.publicUrl, 'The public URL (PUBLIC_URL)');
  } catch (e) { return e.message; }
  return null;
}

/** The OIDC redirect URI: always derived from PUBLIC_URL, never from request headers. */
export function redirectUriFor(settings) {
  return settings.publicUrl ? `${settings.publicUrl}${OIDC_CALLBACK_PATH}` : '';
}

function envValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(',');
  return String(value ?? '');
}

/**
 * Write every setting that differs between `current` and `next` to .env in a
 * single atomic update (an empty value removes the line). Returns the number
 * of keys written.
 */
export async function persistAuthSettings(current, next, { envPath = resolveEnvFile() } = {}) {
  const entries = Object.entries(AUTH_ENV_KEYS)
    .filter(([field]) => envValue(current[field]) !== envValue(next[field]))
    .map(([field, key]) => [key, envValue(next[field])]);
  if (entries.length) await persistEnv(entries, envPath);
  return entries.length;
}
