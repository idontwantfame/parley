// test/helpers/fake-oidc-provider.js — a tiny standards-shaped OpenID provider
// for tests (laid out like Authentik: per-application issuer with a trailing
// slash, shared authorize/token/userinfo endpoints). Serves discovery, a JWKS,
// an /authorize that immediately redirects back with a code (simulating a
// signed-in user who consented), a /token that checks client auth + PKCE and
// issues RS256 ID tokens signed with node:crypto, and /userinfo.
//
// Knobs on the returned object: `user` (claims of whoever "signs in" next),
// `groupsInUserinfoOnly`, `tamper` ('signature' | 'nonce' | 'audience' |
// 'expired' | 'issuer'), `authorizeError`, `algs`, `metadata` (overrides merged
// into the discovery document), `requests` (counters).
// Not a test file itself; node --test lists it as an empty passing file.

import express from 'express';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const KID = 'test-key-1';

function signJwt(claims, privateKey) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64url(claims);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function clientCredentials(req) {
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
  if (basic) {
    const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
    return { id, secret };
  }
  return { id: req.body.client_id, secret: req.body.client_secret };
}

export async function startFakeProvider({ clientId = 'parley-client', clientSecret = 'parley-secret' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: wrongKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map();
  const accessTokens = new Map();
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const p = {
    clientId, clientSecret, issuer: '', base: '',
    user: { sub: 'user-1', preferred_username: 'jane', email: 'jane@example.com', email_verified: true, groups: [] },
    groupsInUserinfoOnly: false, tamper: null, authorizeError: null, algs: ['RS256'], userinfoFails: false, metadata: {},
    requests: { discovery: 0, authorize: [], token: 0, userinfo: 0 },
  };

  app.get('/application/o/parley/.well-known/openid-configuration', (_req, res) => {
    p.requests.discovery += 1;
    res.json({
      issuer: p.issuer,
      authorization_endpoint: `${p.base}/application/o/authorize/`,
      token_endpoint: `${p.base}/application/o/token/`,
      userinfo_endpoint: `${p.base}/application/o/userinfo/`,
      jwks_uri: `${p.base}/application/o/parley/jwks/`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: p.algs,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      ...p.metadata,
    });
  });

  app.get('/application/o/parley/jwks/', (_req, res) => {
    res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
  });

  app.get('/application/o/authorize/', (req, res) => {
    const q = req.query;
    p.requests.authorize.push(q);
    const back = new URL(q.redirect_uri);
    if (q.client_id !== clientId || q.response_type !== 'code' || q.code_challenge_method !== 'S256') {
      return res.status(400).send('bad authorize request');
    }
    if (p.authorizeError) {
      back.searchParams.set('error', p.authorizeError);
      back.searchParams.set('error_description', 'internal provider detail <do-not-echo>');
    } else {
      const code = randomBytes(16).toString('hex');
      codes.set(code, { user: { ...p.user }, nonce: q.nonce, challenge: q.code_challenge, redirectUri: q.redirect_uri });
      back.searchParams.set('code', code);
    }
    if (q.state !== undefined) back.searchParams.set('state', q.state);
    res.redirect(302, back.href);
  });

  function idTokenClaims(grant) {
    const now = Math.floor(Date.now() / 1000);
    const { groups, ...rest } = grant.user;
    const claims = { iss: p.issuer, aud: clientId, iat: now, exp: now + 300, auth_time: now, nonce: grant.nonce,
      ...rest, ...(p.groupsInUserinfoOnly ? {} : { groups }) };
    if (p.tamper === 'nonce') claims.nonce = 'forged-nonce';
    if (p.tamper === 'audience') claims.aud = 'someone-else';
    if (p.tamper === 'expired') { claims.exp = now - 3600; claims.iat = now - 7200; }
    if (p.tamper === 'issuer') claims.iss = 'https://evil.example/';
    return claims;
  }

  app.post('/application/o/token/', (req, res) => {
    p.requests.token += 1;
    const { id, secret } = clientCredentials(req);
    if (id !== clientId || secret !== clientSecret) return res.status(401).json({ error: 'invalid_client' });
    const grant = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (!grant || req.body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'invalid_grant' });
    if (req.body.redirect_uri !== grant.redirectUri) return res.status(400).json({ error: 'invalid_grant' });
    const challenge = createHash('sha256').update(String(req.body.code_verifier ?? '')).digest('base64url');
    if (challenge !== grant.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE' });
    const accessToken = randomBytes(16).toString('hex');
    accessTokens.set(accessToken, grant.user);
    const key = p.tamper === 'signature' ? wrongKey : privateKey;
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: signJwt(idTokenClaims(grant), key) });
  });

  app.get('/application/o/userinfo/', (req, res) => {
    p.requests.userinfo += 1;
    const user = accessTokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!user || p.userinfoFails) return res.status(401).json({ error: 'invalid_token' });
    res.json(user);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  p.base = `http://127.0.0.1:${server.address().port}`;
  p.issuer = `${p.base}/application/o/parley/`;
  p.close = () => new Promise((resolve) => server.close(resolve));
  return p;
}
