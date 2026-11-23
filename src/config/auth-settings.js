// src/config/auth-settings.js
// Dashboard sign-in settings: OpenID Connect single sign-on + password login.
// Pure parsing of env vars into one frozen settings object (config.auth). The
// dashboard edits the same keys through src/store/oidc-settings.js, which
// writes them to .env and swaps in a new object live.
//
// SSO is OFF unless OIDC_ENABLED=true; password login is ON unless
// PASSWORD_LOGIN=false — and even then only once an admin has signed in with
// SSO under the current settings (OIDC_VERIFIED, see src/store/oidc-settings.js).

export const AUTH_DEFAULTS = Object.freeze({
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  allowedGroups: Object.freeze([]),
  adminGroup: '',
  autoCreate: true,
  label: 'Sign in with SSO',
  publicUrl: '',
  passwordLogin: true,
  // Fingerprint of the sign-in settings an admin last completed an SSO sign-in
  // with. Written by Parley only; never accepted from the dashboard.
  verifiedFingerprint: '',
});

// settings field -> env var (the only keys the dashboard ever writes for auth)
export const AUTH_ENV_KEYS = Object.freeze({
  enabled: 'OIDC_ENABLED',
  issuer: 'OIDC_ISSUER',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
  scopes: 'OIDC_SCOPES',
  groupsClaim: 'OIDC_GROUPS_CLAIM',
  allowedGroups: 'OIDC_ALLOWED_GROUPS',
  adminGroup: 'OIDC_ADMIN_GROUP',
  autoCreate: 'OIDC_AUTO_CREATE',
  label: 'OIDC_BUTTON_LABEL',
  publicUrl: 'PUBLIC_URL',
  passwordLogin: 'PASSWORD_LOGIN',
  verifiedFingerprint: 'OIDC_VERIFIED',
});

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

export function parseBool(value, fallback) {
  const word = String(value ?? '').trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return fallback;
}

/** "a, b,,a" -> ['a', 'b'] (trimmed, no empties, no duplicates). */
export function parseGroups(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return Object.freeze([...new Set(list.map((g) => String(g).trim()).filter(Boolean))]);
}

export const normalizeScopes = (value) => String(value ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
export const stripTrailingSlashes = (value) => String(value ?? '').trim().replace(/\/+$/, '');

const text = (value) => String(value ?? '').trim();
const textOr = (value, fallback) => text(value) || fallback;

/**
 * Does SSO create accounts for first-time users? Only with OIDC_AUTO_CREATE on
 * AND a group allowlist: without one, anyone the identity provider knows could
 * mint themselves an account, so only existing or linked accounts sign in.
 */
export function autoCreateEffective(settings) {
  return !!settings.autoCreate && (settings.allowedGroups?.length ?? 0) > 0;
}

/** Typed, frozen auth settings from an env-like object. */
export function resolveAuthSettings(env = process.env) {
  const d = AUTH_DEFAULTS;
  return Object.freeze({
    enabled: parseBool(env.OIDC_ENABLED, d.enabled),
    issuer: text(env.OIDC_ISSUER), // kept verbatim: discovery compares it exactly
    clientId: text(env.OIDC_CLIENT_ID),
    clientSecret: text(env.OIDC_CLIENT_SECRET),
    scopes: normalizeScopes(env.OIDC_SCOPES) || d.scopes,
    groupsClaim: textOr(env.OIDC_GROUPS_CLAIM, d.groupsClaim),
    allowedGroups: parseGroups(env.OIDC_ALLOWED_GROUPS),
    adminGroup: text(env.OIDC_ADMIN_GROUP),
    autoCreate: parseBool(env.OIDC_AUTO_CREATE, d.autoCreate),
    label: textOr(env.OIDC_BUTTON_LABEL, d.label),
    publicUrl: stripTrailingSlashes(env.PUBLIC_URL),
    passwordLogin: parseBool(env.PASSWORD_LOGIN, d.passwordLogin),
    verifiedFingerprint: text(env.OIDC_VERIFIED),
  });
}
