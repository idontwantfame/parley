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
    return fetch(`/api/guilds/${g}/meetings${qs ? `?${qs}` : ''}`).then(json);
  },
  live: (g) => fetch(`/api/guilds/${g}/live`).then(json),
  stopLive: (g, channelId) => fetch(`/api/guilds/${g}/live/${channelId}/stop`, { method: 'POST' }).then(json),
  stats: (g) => fetch(`/api/guilds/${g}/stats`).then(json),
  meeting: (id) => fetch(`/api/meetings/${id}`).then(json),
  // Export URL for a download link/button (md or json). Not fetched via json().
  exportMeetingUrl: (id, format = 'md') => `/api/meetings/${id}/export?format=${format}`,
  meetingAudioUrl: (id) => `/api/meetings/${id}/audio`,
  deleteMeetingAudio: (id) => fetch(`/api/meetings/${id}/audio`, { method: 'DELETE' }).then(json),
  postMeetingNotes: (id) => fetch(`/api/meetings/${id}/repost`, { method: 'POST' }).then(json),
  meetingProgress: (id) => fetch(`/api/meetings/${id}/progress`).then(json),
  todos: (g, { open } = {}) => fetch(`/api/guilds/${g}/todos${open ? '?open=1' : ''}`).then(json),
  ask: (g, id, question) => fetch(`/api/guilds/${g}/meetings/${id}/ask`, jsonBody('POST', { question })).then(json),
  setTodoDone: (id, done) => fetch(`/api/todos/${id}`, jsonBody('PATCH', { done })).then(json),
  deleteMeeting: (id) => fetch(`/api/meetings/${id}`, { method: 'DELETE' }).then(json),
  mergeMeetings: (id, sourceIds) => fetch(`/api/meetings/${id}/merge`, jsonBody('POST', { sourceIds })).then(json),
  search: (g, q) => fetch(`/api/guilds/${g}/search?q=${encodeURIComponent(q)}`).then(json),
  // ── Campaigns ─────────────────────────────────────────────────────────────
  campaigns: (g) => fetch(`/api/guilds/${g}/campaigns`).then(json),
  createCampaign: (g, payload) => fetch(`/api/guilds/${g}/campaigns`, jsonBody('POST', payload)).then(json),
  voiceChannels: (g) => fetch(`/api/guilds/${g}/voice-channels`).then(json),
  campaign: (id) => fetch(`/api/campaigns/${id}`).then(json),
  updateCampaign: (id, patch) => fetch(`/api/campaigns/${id}`, jsonBody('PATCH', patch)).then(json),
  deleteCampaign: (id) => fetch(`/api/campaigns/${id}`, { method: 'DELETE' }).then(json),
  linkChannel: (id, payload) => fetch(`/api/campaigns/${id}/channels`, jsonBody('POST', payload)).then(json),
  unlinkChannel: (id, channelId) => fetch(`/api/campaigns/${id}/channels/${channelId}`, { method: 'DELETE' }).then(json),
  setMeetingCampaign: (meetingId, campaignId) => fetch(`/api/meetings/${meetingId}/campaign`, jsonBody('PUT', { campaignId })).then(json),
  updateJournal: (id, rebuild = false) => fetch(`/api/campaigns/${id}/journal/update`, jsonBody('POST', { rebuild })).then(json),
  askCampaign: (id, question) => fetch(`/api/campaigns/${id}/ask`, jsonBody('POST', { question })).then(json),
  recapCampaign: (id, sessions) => fetch(`/api/campaigns/${id}/recap`, jsonBody('POST', { sessions })).then(json),
  retryMeeting: (id) => fetch(`/api/meetings/${id}/retry`, { method: 'POST' }).then(json),
  regenerateSummary: (id) => fetch(`/api/meetings/${id}/regenerate`, { method: 'POST' }).then(json),
  regenerationStatus: (id) => fetch(`/api/meetings/${id}/regenerate`).then(json),
  commands: () => fetch('/api/commands').then(json),
  config: (g) => fetch(`/api/guilds/${g}/config`).then(json),
  saveConfig: (g, patch) => fetch(`/api/guilds/${g}/config`, jsonBody('PATCH', patch)).then(json),
  vocabulary: () => fetch('/api/vocabulary').then(json),
  importVocabulary: (text) => fetch('/api/vocabulary', jsonBody('PUT', { text })).then(json),
  speakerNames: (g) => fetch(`/api/guilds/${g}/speaker-names`).then(json),
  setSpeakerName: (g, id, name) => fetch(`/api/guilds/${g}/speaker-names/${id}`, jsonBody('PUT', { name })).then(json),
  providerModels: (provider, refresh = false) => fetch(`/api/providers/${provider}/models${refresh ? '?refresh=1' : ''}`).then(json),
  setProviderKey: (provider, key) => fetch(`/api/providers/${provider}/key`, jsonBody('PUT', { key })).then(json),
  systemStatus: () => fetch('/api/system/status').then(json),
  setConnection: (patch) => fetch('/api/system/connection', jsonBody('PUT', patch)).then(json),
  botAction: (action) => fetch(`/api/system/bot/${action}`, { method: 'POST' }).then(json),
  sidecarAction: (action) => fetch(`/api/system/sidecar/${action}`, { method: 'POST' }).then(json),

  // ── Auth ──────────────────────────────────────────────────────────────────
  me: () => fetch('/api/auth/me').then(json),
  login: (username, password) => fetch('/api/auth/login', jsonBody('POST', { username, password })).then(json),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(json),
  changePassword: (currentPassword, newPassword) =>
    fetch('/api/auth/password', jsonBody('POST', { currentPassword, newPassword })).then(json),
  users: () => fetch('/api/users').then(json),
  createUser: (payload) => fetch('/api/users', jsonBody('POST', payload)).then(json),
  updateUser: (id, patch) => fetch(`/api/users/${id}`, jsonBody('PATCH', patch)).then(json),
  resetUserPassword: (id, password) => fetch(`/api/users/${id}/password`, jsonBody('POST', { password })).then(json),
  deleteUser: (id) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then(json),
};
