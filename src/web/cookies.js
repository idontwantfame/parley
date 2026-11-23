// src/web/cookies.js
// Minimal cookie helpers shared by the password and SSO sign-in routes. No dep:
// we only ever read our own cookies and write a handful of attributes.

export const SESSION_COOKIE = 'parley_session';
const EPOCH = new Date(0).toUTCString();

// Minimal cookie parser — returns one cookie's value, or null.
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    // A malformed escape is a bad cookie, not a server error: treat as absent.
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
  }
  return null;
}

/**
 * Append an HttpOnly, SameSite=Lax cookie. `secure` adds Secure (only over
 * https, so localhost http dev still works; Express sets req.secure from the
 * connection / X-Forwarded-Proto when trust proxy is on).
 */
export function setCookie(res, name, value, { path = '/', expires, maxAgeSec, secure = false } = {}) {
  const attrs = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) attrs.push(`Max-Age=${maxAgeSec}`);
  if (expires) attrs.push(`Expires=${expires}`);
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearCookie(res, name, { path = '/', secure = false } = {}) {
  setCookie(res, name, '', { path, expires: EPOCH, secure }); // mirror Secure so browsers match it
}

export function setSessionCookie(res, token, expiresAt, secure) {
  setCookie(res, SESSION_COOKIE, token, { expires: new Date(expiresAt).toUTCString(), secure });
}

export function clearSessionCookie(res, secure) {
  clearCookie(res, SESSION_COOKIE, { secure });
}
