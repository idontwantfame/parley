// src/web/oidc-accounts.js
// Who may sign in with SSO, and which local account they land in. Pure rules
// over the users store; the protocol work (token + ID token validation) has
// already happened in openid-client by the time these run.
//
//   1. Allowlist   — OIDC_ALLOWED_GROUPS set → must be in one of them.
//   2. Linked      — an account linked to (issuer, sub) is used as is.
//   3. Email link  — else a single local account with the same email is linked,
//                    but ONLY when the provider says email_verified === true.
//   4. Auto-create — else (OIDC_AUTO_CREATE, and only with an allowlist) a new
//                    SSO-only, non-admin account.
//   5. Admin sync  — OIDC_ADMIN_GROUP set → admin = membership, at every sign-in,
//                    except the last remaining admin is never demoted.
// Failures are { error: code } using the /?authError= codes of the callback.

import { normalizeUsername, USERNAME_MAX } from '../store/users.js';
import { autoCreateEffective } from '../config/auth-settings.js';

const MAX_USERNAME_SUFFIX = 100;
const USERNAME_DISALLOWED = /[^\p{L}\p{N}._-]+/gu;
const EDGE_DASHES = /^-+|-+$/g;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

function groupsFrom(value) {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value) ? value.filter((g) => typeof g === 'string') : [];
}

/** The identity facts we use, from validated ID token (+ userinfo) claims. */
export function profileFromClaims(claims, groupsClaim) {
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: str(claims.email),
    // Some providers send the string "true"; nothing else counts.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    preferredUsername: str(claims.preferred_username),
    groups: groupsFrom(claims[groupsClaim]),
  };
}

// At most `max` UTF-16 units, never ending in half of a surrogate pair (SQLite
// would store that as U+FFFD, a character usernames must not contain).
const truncate = (value, max) => value.slice(0, max).replace(TRAILING_HIGH_SURROGATE, '');

// NFKC (so look-alike full-width forms collapse), lowercase, then only
// letters, digits, ".", "_" and "-"; any other run becomes one "-".
const cleanUsername = (raw) => truncate(normalizeUsername(String(raw ?? '').normalize('NFKC'))
  .replace(USERNAME_DISALLOWED, '-').replace(EDGE_DASHES, ''), USERNAME_MAX).replace(EDGE_DASHES, '');

/** Base username for a new account: preferred_username → email local part → "user". */
export function usernameFor(profile) {
  const options = [profile.preferredUsername, str(profile.email).split('@')[0]];
  return options.map(cleanUsername).find(Boolean) || 'user';
}

function freeUsername(users, base) {
  if (!users.getUserByUsername(base)) return base;
  for (let n = 2; n <= MAX_USERNAME_SUFFIX; n += 1) {
    const suffix = `-${n}`;
    const name = `${truncate(base, USERNAME_MAX - suffix.length)}${suffix}`;
    if (!users.getUserByUsername(name)) return name;
  }
  return null;
}

function linkByVerifiedEmail(users, profile) {
  if (!profile.email || !profile.emailVerified) return null;
  const matches = users.findUsersByEmail(profile.email);
  if (matches.length === 0) return null;
  // Ambiguous, or already linked to a different identity: never guess.
  if (matches.length > 1 || matches[0].sso) return { error: 'account_conflict' };
  return { user: users.linkOidc(matches[0].id, profile.issuer, profile.subject) };
}

function createAccount(users, profile, settings) {
  const username = freeUsername(users, usernameFor(profile));
  if (!username) return { error: 'account_conflict' };
  const isAdmin = !!settings.adminGroup && profile.groups.includes(settings.adminGroup);
  try {
    // Only a verified email is stored: an unverified one must not be able to
    // claim an address that a later verified sign-in would link by.
    const email = profile.emailVerified ? profile.email || null : null;
    return { user: users.createSsoUser({ username, email, issuer: profile.issuer, subject: profile.subject, isAdmin }) };
  } catch {
    return { error: 'account_conflict' };
  }
}

function syncAdmin(users, user, profile, settings, log) {
  if (!settings.adminGroup) return user;
  const shouldBeAdmin = profile.groups.includes(settings.adminGroup);
  if (shouldBeAdmin === user.isAdmin) return user;
  if (!shouldBeAdmin && users.countAdmins() <= 1) {
    log.warn(`[oidc] "${user.username}" is not in the admin group but is the last admin; not demoting.`);
    return user;
  }
  log.info?.(`[oidc] ${shouldBeAdmin ? 'promoted' : 'demoted'} "${user.username}" from admin group membership.`);
  return users.updateUser(user.id, { isAdmin: shouldBeAdmin });
}

function isAllowed(profile, settings) {
  if (!settings.allowedGroups.length) return true;
  return profile.groups.some((g) => settings.allowedGroups.includes(g));
}

/** Resolve a signed-in SSO identity to a local account: { user } or { error }. */
export function resolveSsoAccount({ users, settings, profile, log = console }) {
  if (!profile.issuer || !profile.subject) return { error: 'provider_error' };
  if (!isAllowed(profile, settings)) return { error: 'not_allowed' };
  const linked = users.getUserByOidc(profile.issuer, profile.subject);
  let result = linked ? { user: linked } : linkByVerifiedEmail(users, profile);
  if (!result) {
    if (!autoCreateEffective(settings)) return { error: 'no_account' };
    result = createAccount(users, profile, settings);
  }
  if (result.error) return result;
  return { user: syncAdmin(users, result.user, profile, settings, log) };
}
