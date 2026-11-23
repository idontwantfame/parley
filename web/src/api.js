// Optional hook the app installs so a 401 anywhere (an expired/cleared session)
// can drop the UI back to the login screen instead of surfacing a raw
// "Not authenticated" error string on whatever page the user was on.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// Build an Error from a failed response, preferring the server's JSON {error}
// but falling back cleanly when the body is HTML (e.g. an older server's 404
// page) so callers never see a raw "JSON.parse: unexpected character" error.
async function responseError(r) {
  let message = r.status === 401 ? 'Not authenticated' : (r.statusText || `Request failed (${r.status})`);
  try { const body = await r.json(); if (body?.error) message = body.error; } catch { /* non-JSON body */ }
  const err = new Error(message);
  err.status = r.status;
  return err;
}

const json = async (r) => {
  if (r.ok) return r.json();
  // Surface auth failures distinctly so the app can drop back to the login
  // screen, but keep the server's message (a failed login says "Invalid
  // username or password.", not "Not authenticated").
  if (r.status === 401 && onUnauthorized) {
    try { onUnauthorized(); } catch { /* ignore */ }
  }
  throw await responseError(r);
};

// Every id/name interpolated into a request path is encoded as one segment, so
// a crafted route param (e.g. "..%2Fsystem%2Fstatus") can't retarget a call.
const seg = (value) => encodeURIComponent(String(value));

// Upload a recording for import as the raw request body. XHR rather than
// fetch because fetch can't report upload progress for a large file.
function uploadRecording(guildId, file, params = {}, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/guilds/${seg(guildId)}/imports?${qs}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check the connection and try again.'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      if (xhr.status === 401 && onUnauthorized) { try { onUnauthorized(); } catch { /* ignore */ } }
      const fallback = xhr.status === 413 ? 'The file is larger than this server accepts.' : `Upload failed (${xhr.status}).`;
      return reject(Object.assign(new Error(body?.error || fallback), { status: xhr.status }));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

const jsonBody = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  guilds: () => fetch('/api/guilds').then(json),
  // Newest first. `before` is a meeting id cursor for the next (older) page.
  meetings: (g, { limit, before } = {}) => {
    const p = new URLSearchParams();
    if (limit) p.set('limit', String(limit));
    if (before) p.set('before', String(before));
    const qs = p.toString();
    return fetch(`/api/guilds/${seg(g)}/meetings${qs ? `?${qs}` : ''}`).then(json);
  },
  live: (g) => fetch(`/api/guilds/${seg(g)}/live`).then(json),
  stopLive: (g, channelId) => fetch(`/api/guilds/${seg(g)}/live/${seg(channelId)}/stop`, { method: 'POST' }).then(json),
  stats: (g) => fetch(`/api/guilds/${seg(g)}/stats`).then(json),
  meeting: (id) => fetch(`/api/meetings/${seg(id)}`).then(json),
  // Export URL for a download link/button (md or json). Not fetched via json().
  exportMeetingUrl: (id, format = 'md') => `/api/meetings/${seg(id)}/export?format=${encodeURIComponent(format)}`,
  // `inline` streams it for the in-page player (seekable); default downloads.
  meetingAudioUrl: (id, { inline = false } = {}) => `/api/meetings/${seg(id)}/audio${inline ? '?inline=1' : ''}`,
  deleteMeetingAudio: (id) => fetch(`/api/meetings/${seg(id)}/audio`, { method: 'DELETE' }).then(json),
  postMeetingNotes: (id) => fetch(`/api/meetings/${seg(id)}/repost`, { method: 'POST' }).then(json),
  meetingProgress: (id) => fetch(`/api/meetings/${seg(id)}/progress`).then(json),
  todos: (g, { open } = {}) => fetch(`/api/guilds/${seg(g)}/todos${open ? '?open=1' : ''}`).then(json),
  ask: (g, id, question) => fetch(`/api/guilds/${seg(g)}/meetings/${seg(id)}/ask`, jsonBody('POST', { question })).then(json),
  setTodoDone: (id, done) => fetch(`/api/todos/${seg(id)}`, jsonBody('PATCH', { done })).then(json),
  deleteMeeting: (id) => fetch(`/api/meetings/${seg(id)}`, { method: 'DELETE' }).then(json),
  mergeMeetings: (id, sourceIds) => fetch(`/api/meetings/${seg(id)}/merge`, jsonBody('POST', { sourceIds })).then(json),
  search: (g, q) => fetch(`/api/guilds/${seg(g)}/search?q=${encodeURIComponent(q)}`).then(json),
  // ── Campaigns ─────────────────────────────────────────────────────────────
  campaigns: (g) => fetch(`/api/guilds/${seg(g)}/campaigns`).then(json),
  createCampaign: (g, payload) => fetch(`/api/guilds/${seg(g)}/campaigns`, jsonBody('POST', payload)).then(json),
  voiceChannels: (g) => fetch(`/api/guilds/${seg(g)}/voice-channels`).then(json),
  campaign: (id) => fetch(`/api/campaigns/${seg(id)}`).then(json),
  updateCampaign: (id, patch) => fetch(`/api/campaigns/${seg(id)}`, jsonBody('PATCH', patch)).then(json),
  deleteCampaign: (id) => fetch(`/api/campaigns/${seg(id)}`, { method: 'DELETE' }).then(json),
  linkChannel: (id, payload) => fetch(`/api/campaigns/${seg(id)}/channels`, jsonBody('POST', payload)).then(json),
  unlinkChannel: (id, channelId) => fetch(`/api/campaigns/${seg(id)}/channels/${seg(channelId)}`, { method: 'DELETE' }).then(json),
  setMeetingCampaign: (meetingId, campaignId) => fetch(`/api/meetings/${seg(meetingId)}/campaign`, jsonBody('PUT', { campaignId })).then(json),
  updateJournal: (id, rebuild = false) => fetch(`/api/campaigns/${seg(id)}/journal/update`, jsonBody('POST', { rebuild })).then(json),
  askCampaign: (id, question) => fetch(`/api/campaigns/${seg(id)}/ask`, jsonBody('POST', { question })).then(json),
  recapCampaign: (id, sessions) => fetch(`/api/campaigns/${seg(id)}/recap`, jsonBody('POST', { sessions })).then(json),
  retryMeeting: (id) => fetch(`/api/meetings/${seg(id)}/retry`, { method: 'POST' }).then(json),
  approveSpeakers: (id, names) => fetch(`/api/meetings/${seg(id)}/speaker-review`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }),
  }).then(json),
  regenerateSummary: (id) => fetch(`/api/meetings/${seg(id)}/regenerate`, { method: 'POST' }).then(json),
  regenerationStatus: (id) => fetch(`/api/meetings/${seg(id)}/regenerate`).then(json),
  commands: () => fetch('/api/commands').then(json),
  config: (g) => fetch(`/api/guilds/${seg(g)}/config`).then(json),
  saveConfig: (g, patch) => fetch(`/api/guilds/${seg(g)}/config`, jsonBody('PATCH', patch)).then(json),
  vocabulary: () => fetch('/api/vocabulary').then(json),
  importVocabulary: (text) => fetch('/api/vocabulary', jsonBody('PUT', { text })).then(json),
  speakerNames: (g) => fetch(`/api/guilds/${seg(g)}/speaker-names`).then(json),
  setSpeakerName: (g, id, name) => fetch(`/api/guilds/${seg(g)}/speaker-names/${seg(id)}`, jsonBody('PUT', { name })).then(json),
  // ── Recording import ──────────────────────────────────────────────────────
  importCapability: () => fetch('/api/imports/capability').then(json),
  importRecording: (g, file, params, options) => uploadRecording(g, file, params, options),
  providerModels: (provider, refresh = false) => fetch(`/api/providers/${seg(provider)}/models${refresh ? '?refresh=1' : ''}`).then(json),
  setProviderKey: (provider, key) => fetch(`/api/providers/${seg(provider)}/key`, jsonBody('PUT', { key })).then(json),
  systemStatus: () => fetch('/api/system/status').then(json),
  setConnection: (patch) => fetch('/api/system/connection', jsonBody('PUT', patch)).then(json),
  botAction: (action) => fetch(`/api/system/bot/${seg(action)}`, { method: 'POST' }).then(json),
  sidecarAction: (action) => fetch(`/api/system/sidecar/${seg(action)}`, { method: 'POST' }).then(json),

  // ── Auth ──────────────────────────────────────────────────────────────────
  me: () => fetch('/api/auth/me').then(json),
  // Full-page navigation target that starts single sign-on (not fetched).
  ssoLoginUrl: (returnTo = '/') => `/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
  authSettings: () => fetch('/api/system/auth').then(json),
  saveAuthSettings: (patch) => fetch('/api/system/auth', jsonBody('PUT', patch)).then(json),
  login: (username, password) => fetch('/api/auth/login', jsonBody('POST', { username, password })).then(json),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(json),
  changePassword: (currentPassword, newPassword) =>
    fetch('/api/auth/password', jsonBody('POST', { currentPassword, newPassword })).then(json),
  users: () => fetch('/api/users').then(json),
  createUser: (payload) => fetch('/api/users', jsonBody('POST', payload)).then(json),
  updateUser: (id, patch) => fetch(`/api/users/${seg(id)}`, jsonBody('PATCH', patch)).then(json),
  resetUserPassword: (id, password) => fetch(`/api/users/${seg(id)}/password`, jsonBody('POST', { password })).then(json),
  deleteUser: (id) => fetch(`/api/users/${seg(id)}`, { method: 'DELETE' }).then(json),
};
