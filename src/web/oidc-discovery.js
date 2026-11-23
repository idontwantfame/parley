// src/web/oidc-discovery.js
// Talking to the identity provider: OIDC discovery through openid-client, a
// fetch that refuses link-local / cloud-metadata targets for every provider
// request, sanity checks on the discovered metadata, and readable reasons for
// failures. openid-client itself never follows redirects (redirect: 'manual').

import * as client from 'openid-client';
import { isBlockedHost } from '../store/secrets.js';

export const DISCOVERY_TIMEOUT_SEC = 10; // also applies to token, userinfo and JWKS requests
const MAX_REPORTED_ISSUER = 200;
const ASYMMETRIC_ALG = /^(RS|PS|ES)\d{3}$|^EdDSA$|^Ed25519$/;

class ProviderProblem extends Error {}

// Endpoints Parley's server calls (or would send users to for logout): none
// may point at a blocked address, whatever the discovery document says.
const SERVER_SIDE_ENDPOINTS = ['token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'end_session_endpoint'];

function assertEndpointsAllowed(meta) {
  for (const field of SERVER_SIDE_ENDPOINTS) {
    if (!meta[field]) continue;
    let host;
    try { host = new URL(meta[field]).hostname; } catch { throw new ProviderProblem(`The provider's ${field} is not a valid URL.`); }
    if (isBlockedHost(host)) throw new ProviderProblem(`The provider's ${field} points at a blocked address.`);
  }
}

/** fetch for every provider request: refuses blocked (link-local/metadata) hosts. */
export async function guardedFetch(url, options) {
  const { hostname } = new URL(url instanceof URL ? url.href : String(url));
  if (isBlockedHost(hostname)) throw new ProviderProblem(`Refused a request to a blocked address (${hostname}).`);
  return fetch(url, options);
}

// Refuse providers we could not validate ID tokens for: openid-client checks
// signatures against the JWKS, which only works for asymmetric algorithms.
function assertUsableProvider(meta) {
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new ProviderProblem('The provider metadata has no authorization or token endpoint.');
  }
  if (!meta.jwks_uri) throw new ProviderProblem('The provider publishes no signing keys (jwks_uri).');
  assertEndpointsAllowed(meta);
  const algs = meta.id_token_signing_alg_values_supported;
  if (Array.isArray(algs) && !algs.some((alg) => ASYMMETRIC_ALG.test(alg))) {
    throw new ProviderProblem('The provider signs ID tokens only with a shared secret (e.g. HS256). '
      + 'Give the application an RSA or EC signing key (in Authentik: the provider\'s "Signing Key").');
  }
  const pkce = meta.code_challenge_methods_supported;
  if (Array.isArray(pkce) && !pkce.includes('S256')) {
    throw new ProviderProblem('The provider does not support PKCE with S256.');
  }
}

/** Default discovery: issuer → openid-client Configuration with signature checks on. */
export async function discoverProvider(settings, { timeoutSec = DISCOVERY_TIMEOUT_SEC } = {}) {
  const issuer = new URL(settings.issuer);
  const execute = [client.enableNonRepudiationChecks];
  // Plain-http issuers (LAN-only Authentik) need an explicit opt-in in openid-client.
  if (issuer.protocol === 'http:') execute.push(client.allowInsecureRequests);
  const configuration = await client.discovery(issuer, settings.clientId, settings.clientSecret, undefined,
    { timeout: timeoutSec, execute, [client.customFetch]: guardedFetch }); // kept for all later requests
  assertUsableProvider(configuration.serverMetadata());
  return configuration;
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused', ENOTFOUND: 'host not found', EAI_AGAIN: 'host not found',
  ECONNRESET: 'connection reset', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable',
  CERT_HAS_EXPIRED: 'TLS certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'untrusted TLS certificate',
};

const MAX_REASON = 80;

// Walks the cause chain of a failed request for a short, human reason.
function networkReason(err) {
  let fetchFailed = false;
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
    if (NETWORK_REASONS[e.code]) return NETWORK_REASONS[e.code];
    if (String(e.code ?? '').startsWith('ERR_SSL')) return 'TLS handshake failed; check http vs https';
    if (fetchFailed && typeof e.message === 'string') return e.message.slice(0, MAX_REASON);
    fetchFailed ||= e.message === 'fetch failed';
  }
  return fetchFailed ? 'request failed' : null;
}

/** A readable, secret-free reason for a failed discovery (shown to admins). */
function providerProblemIn(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e instanceof ProviderProblem) return e;
  }
  return null;
}

export function describeDiscoveryError(err, issuer) {
  const problem = providerProblemIn(err);
  if (problem) return problem.message;
  const reported = err?.cause?.attribute === 'issuer' ? err.cause.body?.issuer : undefined;
  if (typeof reported === 'string') {
    return `The provider reports its issuer as "${reported.slice(0, MAX_REPORTED_ISSUER)}". Set the issuer URL to exactly that value.`;
  }
  const reason = networkReason(err);
  let origin = issuer;
  try { origin = new URL(issuer).origin; } catch { /* report the raw value */ }
  if (reason) return `Could not reach the provider at ${origin} (${reason}).`;
  const status = err?.cause?.status;
  if (Number.isInteger(status)) return `The provider's discovery document returned HTTP ${status}. Check the issuer URL.`;
  return `OIDC discovery failed: ${err?.message ?? 'unknown error'}.`;
}
