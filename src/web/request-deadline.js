// src/web/request-deadline.js
// Time limits for incoming requests, so a slow or stalled client can't hold
// connections open (slowloris) before it has even signed in.
//
// Node's own whole-request deadline (server.requestTimeout) is server-wide and
// can't be lifted for one route, yet a multi-gigabyte recording upload needs
// far longer than its 5-minute default. So the server turns it off and this
// middleware enforces the same 5-minute default on every request instead; the
// import route extends the deadline for its own upload only, after the
// uploader has been authenticated (req.extendDeadline).

/** Node's default: the whole request (headers + body) must arrive in 5 minutes. */
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** The request headers must arrive within 30 seconds. */
export const HEADERS_TIMEOUT_MS = 30 * 1000;
/** A connection with no traffic either way for 2 minutes is closed. */
export const IDLE_SOCKET_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * Signed-in requests may wait much longer for the server: summarizing with a
 * slow local model (merge, Ask) can take many minutes with no traffic.
 */
export const SIGNED_IN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const TOO_SLOW = 'The request took too long to arrive.';

/**
 * Apply the server-level limits: no built-in whole-request deadline (this
 * module's middleware enforces it), bounded header reads and idle sockets.
 */
export function applyServerTimeouts(server, {
  headersMs = HEADERS_TIMEOUT_MS, idleMs = IDLE_SOCKET_TIMEOUT_MS,
} = {}) {
  server.requestTimeout = 0;
  server.headersTimeout = headersMs;
  server.timeout = idleMs;
  return server;
}

// Refuse a request that is still arriving and close its connection.
function expire(req, res) {
  if (req.complete) return;
  if (!res.headersSent) {
    res.once('finish', () => req.socket?.destroy());
    res.status(408).set('Connection', 'close').json({ error: TOO_SLOW });
    return;
  }
  req.socket?.destroy();
}

/**
 * Middleware: the request must be fully received within `timeoutMs` of its
 * arrival. Adds req.extendDeadline(ms) to move the deadline to `ms` after the
 * arrival (for a route that legitimately receives a large body).
 */
export function requestDeadline({ timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now } = {}) {
  return (req, res, next) => {
    const arrivedAt = now();
    let timer = null;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => expire(req, res), Math.max(0, arrivedAt + ms - now()));
      timer.unref?.();
    };
    const disarm = () => clearTimeout(timer);
    req.extendDeadline = (ms) => arm(ms);
    req.once('end', disarm);
    req.once('close', disarm);
    res.once('close', disarm);
    if (!req.complete) arm(timeoutMs);
    next();
  };
}

/** Middleware for signed-in requests: allow long server-side work (see above). */
export function signedInIdleTimeout(ms = SIGNED_IN_IDLE_TIMEOUT_MS) {
  return (req, _res, next) => {
    req.setTimeout(ms);
    next();
  };
}
