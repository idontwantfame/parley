// src/web/security-headers.js
// Browser hardening headers for every dashboard response. The built UI loads
// only its own scripts (no inline <script>, no eval), its own styles plus
// React's inline style attributes and Google Fonts, plays recordings from the
// API or blob: URLs, and talks only to its own origin.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

/** Middleware: set the hardening headers on every response. */
export function securityHeaders(_req, res, next) {
  res.set(HEADERS);
  next();
}
