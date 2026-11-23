// src/web/oidc-service.js
// Lifecycle of the sign-in settings and the provider connection (the provider
// talk itself is in oidc-discovery.js, all protocol/crypto in openid-client):
//
//   status()               — { status: 'off'|'ok'|'error', error } (sync snapshot)
//   ensure()               — the openid-client Configuration, discovering when
//                            needed (deduped; failures retried after retryMs)
//   probe(settings)        — discover candidate settings without adopting them
//   serialize(fn)          — run settings changes one at a time
//   commit(current, next)  — persist to .env + apply live → { turnedOff }
//   verify(fingerprint)    — record an admin SSO sign-in under these settings
//   verified()             — SSO on and verified (OIDC_VERIFIED matches)
//   passwordLoginEnabled() — effective: off only if PASSWORD_LOGIN=false AND
//                            verified. Outages do not flip it back on; recover
//                            with PASSWORD_LOGIN=true in .env and a restart.

import { createHash } from 'node:crypto';
import { config, resolveEnvFile } from '../config/env.js';
import {
  isSsoVerified, mergeAuthSettings, passwordLoginEffective, persistAuthSettings, settingsFingerprint, ssoConfigProblem,
} from '../store/oidc-settings.js';
import { DISCOVERY_TIMEOUT_SEC, describeDiscoveryError, discoverProvider } from './oidc-discovery.js';

export { describeDiscoveryError, discoverProvider, guardedFetch } from './oidc-discovery.js';

const DISCOVERY_RETRY_MS = 30_000;

// Settings that require a new discovery when they change. Hashed so the cache
// key never holds the client secret in a loggable form.
const keyOf = (s) => createHash('sha256')
  .update(JSON.stringify([s.enabled, s.issuer, s.clientId, s.clientSecret])).digest('base64url');

const EMPTY_ENTRY = Object.freeze({ key: null, configuration: null, error: null, attemptedAt: 0 });

// Discovery outcomes per settings key: one request in flight per key, and the
// last result (configuration or readable error) remembered with its time.
function createDiscoveryCache({ discover, log, now, timeoutSec, onFailure }) {
  let entry = EMPTY_ENTRY;
  let inflight = null;
  return {
    entry: () => entry,
    adopt(key, configuration) {
      entry = configuration ? Object.freeze({ key, configuration, error: null, attemptedAt: now() }) : EMPTY_ENTRY;
    },
    refresh(s, key) {
      if (inflight?.key === key) return inflight.promise;
      const promise = discover(s, { timeoutSec }).then((configuration) => {
        entry = Object.freeze({ key, configuration, error: null, attemptedAt: now() });
        log.info?.('[oidc] connected to the identity provider.');
        return configuration;
      }, (err) => {
        const error = describeDiscoveryError(err, s.issuer);
        entry = Object.freeze({ key, configuration: null, error, attemptedAt: now() });
        log.warn(`[oidc] discovery failed: ${error}`);
        onFailure(s);
        return null;
      }).finally(() => { if (inflight?.promise === promise) inflight = null; });
      inflight = { key, promise };
      return promise;
    },
  };
}

// A promise chain: each task starts after the previous one settled.
function createSerializer() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    tail = run.catch(() => {});
    return run;
  };
}

function bootWarnings(s, log) {
  const problem = s.enabled ? ssoConfigProblem(s) : null;
  if (problem) log.warn(`[oidc] single sign-on is enabled but not usable: ${problem}`);
  if (s.passwordLogin === false && !isSsoVerified(s)) {
    log.warn('[oidc] PASSWORD_LOGIN=false takes effect only after an admin signs in with single sign-on '
      + 'under the current settings; password sign-in stays enabled until then.');
  }
}

export function createOidcService({
  env = config, envPath = resolveEnvFile(), log = console, discover = discoverProvider, now = () => Date.now(),
  retryMs = DISCOVERY_RETRY_MS, timeoutSec = DISCOVERY_TIMEOUT_SEC,
} = {}) {
  const settings = () => env.auth;
  const warnLockedOut = () => {
    if (passwordLoginEffective(settings())) return;
    log.warn('[oidc] single sign-on is unavailable and password sign-in is turned off. To recover, '
      + 'set PASSWORD_LOGIN=true in .env and restart Parley.');
  };
  const cache = createDiscoveryCache({ discover, log, now, timeoutSec, onFailure: warnLockedOut });

  const service = {
    log,
    envPath, // where the dashboard persists these settings (src/web/auth-settings-routes.js)
    settings,
    serialize: createSerializer(),
    status() {
      const s = settings();
      if (!s.enabled) return { status: 'off', error: null };
      const problem = ssoConfigProblem(s);
      if (problem) return { status: 'error', error: problem };
      const entry = cache.entry();
      if (entry.key !== keyOf(s)) return { status: 'error', error: 'Not connected to the provider yet.' };
      return entry.configuration ? { status: 'ok', error: null } : { status: 'error', error: entry.error };
    },
    async ensure() {
      const s = settings();
      if (!s.enabled || ssoConfigProblem(s)) return null;
      const key = keyOf(s);
      const entry = cache.entry();
      if (entry.key === key && entry.configuration) return entry.configuration;
      if (entry.key === key && now() - entry.attemptedAt < retryMs) return null;
      return cache.refresh(s, key);
    },
    async probe(candidate) {
      const problem = ssoConfigProblem(candidate);
      if (problem) throw new Error(problem);
      try { return await discover(candidate, { timeoutSec }); }
      catch (err) { throw new Error(describeDiscoveryError(err, candidate.issuer)); }
    },
    // Swap in new settings. A freshly probed configuration is adopted; without
    // one the cached connection is kept if the provider is unchanged, else the
    // next ensure() discovers afresh.
    apply(next, configuration = null) {
      env.auth = next;
      const key = keyOf(next);
      if (configuration || cache.entry().key !== key) cache.adopt(key, configuration);
    },
    // Persist (one atomic .env write) and apply. Call inside serialize().
    async commit(current, next, { configuration = null } = {}) {
      const wasOn = service.passwordLoginEnabled();
      await persistAuthSettings(current, next, { envPath });
      service.apply(next, configuration);
      return { turnedOff: wasOn && !service.passwordLoginEnabled() };
    },
    // An admin just completed an SSO sign-in that started under `fingerprint`:
    // if that is still the current configuration, mark it verified.
    verify(fingerprint) {
      return service.serialize(async () => {
        const current = settings();
        if (!current.enabled || isSsoVerified(current) || fingerprint !== settingsFingerprint(current)) {
          return { turnedOff: false };
        }
        const result = await service.commit(current, mergeAuthSettings(current, { verifiedFingerprint: fingerprint }));
        log.info?.('[oidc] sign-in settings verified by an admin SSO sign-in.');
        return result;
      });
    },
    fingerprint: () => settingsFingerprint(settings()),
    verified: () => isSsoVerified(settings()),
    ready: () => service.status().status === 'ok',
    passwordLoginEnabled: () => passwordLoginEffective(settings()),
    publicInfo: () => ({ enabled: service.ready(), label: settings().label }),
    // Boot: report problems loudly and start connecting in the background.
    start() {
      bootWarnings(settings(), log);
      return service.ensure();
    },
  };
  return service;
}
