// src/campaign/ask.js
// Campaign-wide Q&A and "Previously on…" recaps. Whole-campaign transcripts are
// far too big to send (a 4-hour session is ~50k tokens), so the model gets:
//   1. the campaign journal (world state),
//   2. every session's notes, numbered (oldest trimmed to the TL;DR when the
//      campaign is long),
//   3. transcript passages matching the question's keywords (full-text search),
//      with a little surrounding conversation for each hit.
import { getSummarizer } from '../adapters/summarizer/index.js';
import { resolveSummaryLanguage, summaryLanguageInstruction } from '../adapters/summarizer/languages.js';
import { getGuildConfig } from '../store/config.js';
import { formatMs } from '../pipeline/summarize.js';
import { trimJournal } from './journal.js';
import { extractTerms } from '../pipeline/search-terms.js';

export { extractTerms };

const NOTES_BUDGET = 60_000; // characters of session notes
const EXCERPT_BUDGET = 30_000; // characters of transcript excerpts
const EXCERPT_HITS = 15;
const WINDOW_MS = 30_000; // conversation kept on each side of a hit
const JOURNAL_BUDGET = 4000; // characters of campaign journal
const TAIL_LINES = 60; // closing lines of the last session for a recap

/** FTS5 query matching any term, with prefix matching so "goblin" finds "goblins". */
export function ftsQuery(terms) {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

function notesBlock(session, full) {
  const head = `### Session ${session.number} — ${(session.started_at || '').slice(0, 10)}`;
  const n = session.notes;
  if (!n) return `${head}\n(no notes)`;
  const lines = [head, n.tldr || ''];
  if (full) {
    for (const t of n.topics || []) {
      lines.push(`- ${t.title}${(t.points || []).length ? `: ${t.points.join('; ')}` : ''}`);
    }
    if ((n.decisions || []).length) lines.push(`- Decisions: ${n.decisions.join('; ')}`);
    if ((n.openQuestions || []).length) lines.push(`- Open questions: ${n.openQuestions.join('; ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

/** Session notes oldest→newest; when over budget, older sessions shrink to their TL;DR. */
export function sessionNotesBlock(sessions, budget = NOTES_BUDGET) {
  const full = sessions.map((s) => notesBlock(s, true));
  const short = sessions.map((s) => notesBlock(s, false));
  const blocks = [...full];
  let total = blocks.reduce((n, b) => n + b.length, 0);
  for (let i = 0; i < blocks.length - 1 && total > budget; i++) {
    total -= blocks[i].length - short[i].length;
    blocks[i] = short[i];
  }
  return blocks.join('\n\n');
}

// One window of conversation per hit; overlapping windows in a session merge.
// Windows come out best match first (a merged window keeps its best rank).
function hitWindows(hits) {
  return hits.reduce((windows, h) => {
    const from = h.start_ms - WINDOW_MS, to = h.start_ms + WINDOW_MS;
    const i = windows.findIndex((w) => w.meetingId === h.meeting_id && from <= w.to && to >= w.from);
    if (i < 0) return [...windows, { meetingId: h.meeting_id, from, to, hitMs: h.start_ms }];
    const w = windows[i];
    return windows.with(i, { ...w, from: Math.min(w.from, from), to: Math.max(w.to, to) });
  }, []);
}

// The lines of a window nearest its hit that fit `limit` characters, in order.
function nearestLines(rows, hitMs, limit) {
  const lines = rows.map((u) => ({ u, text: `${u.display_name}: ${u.text}` }));
  const byDistance = [...lines].sort((a, b) => Math.abs(a.u.start_ms - hitMs) - Math.abs(b.u.start_ms - hitMs));
  const chosen = new Set();
  let used = 0;
  for (const line of byDistance) {
    if (used + line.text.length + 1 > limit) break;
    chosen.add(line);
    used += line.text.length + 1;
  }
  return lines.filter((line) => chosen.has(line));
}

function windowText(db, w, session, limit) {
  const rows = db.utterancesBetween(w.meetingId, w.from, w.to);
  const number = session?.number ?? '?';
  const headerRoom = `[Session ${number}, around 000:00]\n`.length;
  const lines = nearestLines(rows, w.hitMs, limit - headerRoom);
  if (!lines.length) return '';
  // start_ms is absolute; show times relative to the session's first line.
  const origin = db.firstUtteranceMs(w.meetingId) ?? 0;
  return `[Session ${number}, around ${formatMs(Math.max(0, lines[0].u.start_ms - origin))}]\n`
    + lines.map((line) => line.text).join('\n');
}

/**
 * Transcript passages around the best full-text matches for the question.
 * Passages are chosen best match first (an oversize one is cut to the lines
 * nearest its match, or skipped), then shown in session order.
 */
export function transcriptExcerpts(db, campaignId, question, sessions, budget = EXCERPT_BUDGET) {
  const terms = extractTerms(question);
  if (!terms.length) return '';
  let hits;
  try { hits = db.searchCampaignUtterances(campaignId, ftsQuery(terms), EXCERPT_HITS); }
  catch { return ''; } // malformed FTS input should never sink the answer
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const kept = [];
  let used = 0;
  for (const w of hitWindows(hits)) {
    const separator = kept.length ? 2 : 0;
    const session = sessionById.get(w.meetingId);
    const text = windowText(db, w, session, budget - used - separator);
    if (!text) continue;
    kept.push({ number: session?.number ?? 0, from: w.from, text });
    used += separator + text.length;
  }
  return kept
    .sort((a, b) => a.number - b.number || a.from - b.from)
    .map((k) => k.text)
    .join('\n\n');
}

export function buildCampaignAskPrompt({ campaignName, question, journal, notes, excerpts }) {
  return `You are the lore-keeper for a tabletop role-playing campaign called "${campaignName}". Answer the question using ONLY the campaign material below. Speakers in the transcript excerpts are players' Discord names; the journal's Party section maps players to their characters.

- Say which session(s) the answer comes from, e.g. "(Session 4)".
- If the material doesn't contain the answer, say so plainly. Don't invent details.
- Be concise; use a short list when listing several things.

<campaign_journal>
${journal?.trim() || '(empty)'}
</campaign_journal>

<session_notes>
${notes || '(no sessions yet)'}
</session_notes>

<transcript_excerpts>
${excerpts || '(no matching passages)'}
</transcript_excerpts>

Question: ${question}`;
}

export function buildRecapPrompt({ campaignName, journal, notes, lastTranscriptTail, sessionCount }) {
  return `Write a "Previously on…" recap for the tabletop role-playing campaign "${campaignName}", to be read aloud by the Game Master at the start of the next session.

- Cover the last ${sessionCount === 1 ? 'session' : `${sessionCount} sessions`}, weighting the most recent most heavily, and end on where the party stands now: the cliffhanger, the open choice, the immediate threat.
- 150–250 words. Dramatic narrator voice, past tense, addressing the party ("Our heroes…" or "you").
- Use character names, not players' Discord names (the journal's Party section maps them). Leave out out-of-character table talk.
- Output only the recap text.

<campaign_journal>
${journal?.trim() || '(empty)'}
</campaign_journal>

<recent_sessions>
${notes}
</recent_sessions>
${lastTranscriptTail ? `
<end_of_last_session>
${lastTranscriptTail}
</end_of_last_session>` : ''}`;
}

function setup(db, campaignId, { cfg, summarizer, env }) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const c = cfg || getGuildConfig(db, campaign.guild_id);
  const s = summarizer || getSummarizer(c, env);
  if (typeof s.ask !== 'function') throw new Error(`Provider ${c.summarizerProvider} does not support Q&A`);
  const sessions = db.listCampaignSessions(campaignId);
  return { campaign, summarizer: s, sessions, language: resolveSummaryLanguage(c) };
}

export async function askCampaign(db, campaignId, question, opts = {}) {
  const { campaign, summarizer, sessions, language } = setup(db, campaignId, opts);
  const prompt = buildCampaignAskPrompt({
    campaignName: campaign.name,
    question: question.slice(0, 1500),
    journal: trimJournal(campaign.journal, JOURNAL_BUDGET),
    notes: sessionNotesBlock(sessions, 5000).slice(-5000),
    excerpts: transcriptExcerpts(db, campaignId, question, sessions, 4000),
  });
  return summarizer.ask(prompt + summaryLanguageInstruction(language).replace('summary', 'answer'));
}

export async function recapCampaign(db, campaignId, { sessions: count = 1, ...opts } = {}) {
  const { campaign, summarizer, sessions, language } = setup(db, campaignId, opts);
  const done = sessions.filter((s) => s.notes);
  if (!done.length) throw new Error('This campaign has no summarized sessions yet.');
  const n = Math.max(1, Math.min(5, Number(count) || 1));
  const recent = done.slice(-n);
  const last = recent[recent.length - 1];
  const tail = db.listLastUtterances(last.id, TAIL_LINES).map((u) => `${u.display_name}: ${u.text}`).join('\n').slice(-3500);
  const budget = Math.floor(6500 / recent.length);
  const prompt = buildRecapPrompt({
    campaignName: campaign.name,
    journal: trimJournal(campaign.journal, JOURNAL_BUDGET),
    notes: recent.map((s) => notesBlock(s, true).slice(0, budget)).join('\n\n'),
    lastTranscriptTail: tail,
    sessionCount: recent.length,
  });
  return summarizer.ask(prompt + summaryLanguageInstruction(language).replace('summary', 'recap'));
}

/**
 * Pick the campaign a Discord command refers to: an explicit id/name, else the
 * campaign linked to the user's current voice channel, else the guild's most
 * recently active campaign.
 */
export function resolveCampaign(db, guildId, { campaign, voiceChannelId } = {}) {
  const all = db.listCampaigns(guildId);
  if (campaign) {
    const byId = all.find((c) => String(c.id) === String(campaign));
    if (byId) return byId;
    const needle = String(campaign).toLowerCase();
    return all.find((c) => c.name.toLowerCase() === needle) || all.find((c) => c.name.toLowerCase().includes(needle)) || null;
  }
  if (voiceChannelId) {
    const linked = db.campaignForChannel(voiceChannelId);
    if (linked && linked.guild_id === guildId) return linked;
  }
  return all[0] || null;
}
