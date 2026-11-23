// src/web/auth-settings-routes.js
// Admin settings for dashboard sign-in, mounted inside apiRouter (so behind
// requireAuth + requirePasswordChanged):
//
//   GET /api/system/auth — SSO + password-login settings and provider health
//   PUT /api/system/auth — one at a time (serialized): validate → lock-out
//                          guard → discover (when the provider changes) →
//                          persist changed keys to .env in one write → apply
//                          live; returns the GET shape
//
// The client secret is write-only ("clientSecretSet" only). Password login is
// only *effectively* off once an admin has signed in with SSO under the
// current settings (ssoVerified); turning it off additionally requires the
// acting admin's own account to be SSO-linked. When it does switch off, the
// sessions of accounts without SSO are ended (except the acting admin's).

import { requireAdmin } from './auth.js';
import { redactUrl } from '../store/secrets.js';
import { autoCreateEffective } from '../config/auth-settings.js';
import {
  AuthSettingsError, mergeAuthSettings, normalizeAuthPatch, redirectUriFor,
} from '../store/oidc-settings.js';

const KNOWN_FIELDS = new Set(['ssoEnabled', 'issuer', 'clientId', 'clientSecret', 'scopes', 'groupsClaim',
  'allowedGroups', 'adminGroup', 'autoCreate', 'label', 'publicUrl', 'passwordLogin']);
// Settings that need a fresh discovery when they change.
const PROVIDER_FIELDS = ['enabled', 'issuer', 'clientId', 'clientSecret'];

export function authSettingsView(oidc) {
  const s = oidc.settings();
  const { status, error } = oidc.status();
  return {
    sso: {
      enabled: s.enabled, issuer: redactUrl(s.issuer), clientId: s.clientId, clientSecretSet: !!s.clientSecret,
      scopes: s.scopes, groupsClaim: s.groupsClaim, allowedGroups: [...s.allowedGroups], adminGroup: s.adminGroup,
      // Accounts are only created automatically with a group allowlist.
      autoCreate: s.autoCreate, autoCreateEffective: autoCreateEffective(s), label: s.label, status, error,
    },
    passwordLogin: s.passwordLogin, // configured
    passwordLoginEffective: oidc.passwordLoginEnabled(),
    ssoVerified: oidc.verified(),
    publicUrl: s.publicUrl,
    redirectUri: redirectUriFor(s),
  };
}

const providerChanged = (current, patch) => PROVIDER_FIELDS.some((k) => k in patch && patch[k] !== current[k]);

// Turning password login off is only accepted from an admin who can sign in
// with SSO themselves; it then still waits for verification to take effect.
function lockoutProblem({ user, users, current, patch }) {
  if (patch.passwordLogin !== false || current.passwordLogin === false) return null;
  if (user && users?.oidcIdentity(user.id)) return null;
  return 'Sign in with single sign-on at least once before turning off password sign-in, '
    + 'so you cannot lock yourself out.';
}

function parsePatch(body) {
  const fields = Object.keys(body ?? {}).filter((k) => KNOWN_FIELDS.has(k));
  if (!fields.length) throw new AuthSettingsError('No recognized settings to update.');
  return normalizeAuthPatch(body);
}

// Runs inside oidc.serialize(), so `current` cannot go stale mid-update.
async function updateAuthSettings(req, res, { oidc, users }) {
  let patch;
  try { patch = parsePatch(req.body); } catch (e) {
    if (e instanceof AuthSettingsError) return res.status(400).json({ error: e.message });
    throw e;
  }
  const current = oidc.settings();
  const next = mergeAuthSettings(current, patch);
  const lockout = lockoutProblem({ user: req.user, users, current, patch });
  if (lockout) return res.status(409).json({ error: lockout });
  // Discover only when a (new) provider is switched on; anything else (labels,
  // groups, turning password login back on) must work while it is down.
  let configuration = null;
  if (next.enabled && providerChanged(current, patch)) {
    try { configuration = await oidc.probe(next); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  let result;
  try {
    result = await oidc.commit(current, next, { configuration });
  } catch (e) {
    oidc.log?.error?.('[oidc] could not save sign-in settings:', e.message);
    return res.status(500).json({ error: 'Could not save the settings file.' });
  }
  if (result.turnedOff) users?.revokePasswordOnlySessions(req.user?.id ?? null);
  res.json(authSettingsView(oidc));
}

export function mountAuthSettingsRoutes(r, { oidc, users }) {
  r.get('/system/auth', requireAdmin, async (_req, res) => {
    await oidc.ensure(); // report a real connection attempt, not "not connected yet"
    res.json(authSettingsView(oidc));
  });
  r.put('/system/auth', requireAdmin, (req, res) => oidc.serialize(() => updateAuthSettings(req, res, { oidc, users })));
}
