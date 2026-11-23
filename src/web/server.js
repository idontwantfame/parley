// src/web/server.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { apiRouter } from './api.js';
import { securityHeaders } from './security-headers.js';
import { applyServerTimeouts, requestDeadline, signedInIdleTimeout, REQUEST_TIMEOUT_MS } from './request-deadline.js';
import { installUsers } from '../store/users.js';
import { authRouter, attachUser, requireAuth, requirePasswordChanged, sameOrigin } from './auth.js';
import { oidcRouter } from './oidc.js';
import { createOidcService } from './oidc-service.js';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// Expired login sessions are also purged on every login; this catches idle instances.
const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

// Messages for client errors raised by Express itself (body parsing, limits).
const CLIENT_ERRORS = {
  400: 'The request body is not valid JSON.',
  413: 'The request body is too large.',
  415: 'Unsupported request body encoding.',
};

/**
 * Final error handler: log the details server-side, send the client only a
 * generic JSON message (never a stack trace, whatever NODE_ENV says).
 */
export function jsonErrorHandler(log = console) {
  return (err, req, res, _next) => { // 4 params: Express error middleware
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500 && !res.headersSent) {
      return res.status(status).json({ error: CLIENT_ERRORS[status] ?? 'The request could not be processed.' });
    }
    log.error(`[web] ${req.method} ${req.originalUrl} failed:`, err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Something went wrong on the server.' });
  };
}

// Password sign-in can also go off through a restart (e.g. PASSWORD_LOGIN=false
// written back after the PASSWORD_LOGIN=true recovery). Accounts without SSO
// cannot sign in again, so their leftover sessions end now, as they would on a
// live switch-off (auth-settings-routes.js / oidc.js).
function endPasswordOnlySessionsIfOff(users, oidc) {
  if (!oidc.passwordLoginEnabled()) users.revokePasswordOnlySessions();
}

export function createWebServer({
  db, bot = null, client = null, sidecar = null, users = installUsers(db), oidc = createOidcService(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS, distDir = DIST,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Every request must arrive within the deadline (an admin's recording upload
  // extends its own, see import-routes.js).
  app.use(requestDeadline({ timeoutMs: requestTimeoutMs }));
  // Trust only the loopback proxy so req.secure / req.ip reflect a *local*
  // reverse proxy's X-Forwarded-* headers. Trusting every hop (`true`) let any
  // direct client spoof X-Forwarded-For and dodge the per-IP login rate limit.
  // Override with TRUSTED_PROXY when a non-loopback proxy fronts the app.
  app.set('trust proxy', process.env.TRUSTED_PROXY || 'loopback');
  // A 64 KB vocabulary file can grow when encoded as a JSON string.
  app.use(express.json({ limit: '256kb' }));

  // Auth: seed users (default admin on first run) and resolve the session
  // cookie for every request. Login/logout/me/password are public (or self-only)
  // and mounted first; everything else under /api needs a session, a same-origin
  // request (CSRF guard), and an account that has moved off the default password.
  // The /users admin routes inside authRouter apply the password gate themselves.
  // The SSO routes (/auth/oidc/login + /callback) are public GETs, so neither
  // the same-origin guard nor the session gate stands in their way.
  endPasswordOnlySessionsIfOff(users, oidc);
  app.use(attachUser(users));
  app.use('/api', sameOrigin);
  app.use('/api', authRouter({ users, oidc }));
  app.use('/api', oidcRouter({ users, oidc }));
  app.use('/api', requireAuth(users), requirePasswordChanged(users), signedInIdleTimeout(),
    apiRouter({ db, bot, client, sidecar, oidc, users }));

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    // A hashed bundle file that isn't there (a tab open across an upgrade asks
    // for the old chunk) is a 404, never the app shell served as a script.
    app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Not found'));
    // SPA fallback for client-side routes (but never /api)
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
  }
  app.use(jsonErrorHandler());
  return app;
}

const FALLBACK_ATTEMPTS = 10;

// `timeouts` (tests): { requestMs, headersMs, idleMs } — see request-deadline.js.
export async function startWebServer({
  db, bot = null, client = null, sidecar = null, port = 3000, host = process.env.WEB_UI_HOST || '127.0.0.1',
  maxAttempts = FALLBACK_ATTEMPTS, timeouts = {},
}) {
  db.backfillTodos();
  const users = installUsers(db);
  const oidc = createOidcService();
  // Connect to the identity provider in the background (never blocks boot).
  oidc.start().catch((e) => console.warn('[oidc] startup check failed:', e.message));
  const app = createWebServer({ db, bot, client, sidecar, users, oidc, requestTimeoutMs: timeouts.requestMs });
  const server = await listenWithFallback(app, port, host, maxAttempts);
  // Bounded header reads and idle sockets; the whole-request deadline is the
  // requestDeadline middleware's (so an import upload can extend its own).
  applyServerTimeouts(server, timeouts);
  const purge = setInterval(() => {
    try { users.purgeExpiredSessions(); } catch (e) { console.warn('[web] session purge failed:', e.message); }
  }, SESSION_PURGE_INTERVAL_MS).unref();
  server.once('close', () => clearInterval(purge));
  return server;
}

// Bind preferred port; on EADDRINUSE walk +1 up to maxAttempts. Port 0
// (OS-assigned) is a single shot — incrementing it would try privileged ports.
function listenWithFallback(app, port, host, maxAttempts) {
  return new Promise((resolve, reject) => {
    const tryListen = (candidate, remaining) => {
      const server = app.listen(candidate, host);
      server.once('listening', () => resolve(server));
      server.once('error', (err) => {
        server.close();
        if (err.code === 'EADDRINUSE' && candidate !== 0 && remaining > 1) {
          console.warn(`[web] port ${candidate} in use, trying ${candidate + 1}`);
          tryListen(candidate + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
    };
    tryListen(port, maxAttempts);
  });
}
