// src/campaign/journal.js
// The campaign journal: one living Markdown document per campaign (party,
// NPCs, places, quests, loot, lore) that the LLM rewrites after each session.
// The session-by-session log is NOT part of it — each session's own notes
// already serve that role — so the document tracks world state and stays
// compact instead of growing with every session.
import { getSummarizer } from '../adapters/summarizer/index.js';
import { resolveSummaryLanguage, summaryLanguageInstruction } from '../adapters/summarizer/languages.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { getGuildConfig } from '../store/config.js';
import { buildTranscript } from '../pipeline/summarize.js';

export const JOURNAL_SECTIONS = [
  'Party',
  'NPCs',
  'Locations',
  'Quests & Plot Threads',
  'Items & Loot',
  'Lore & World',
  'Open Mysteries',
];

export const EMPTY_JOURNAL = JOURNAL_SECTIONS.map((s) => `## ${s}\n- (nothing yet)`).join('\n\n');

export function buildJournalUpdatePrompt({
  campaignName, journal, transcript, sessionNumber, date, attendees = [], tldr, summaryLanguage, sessionNotesOnly = false,
}) {
  const sections = JOURNAL_SECTIONS.map((s) => `## ${s}`).join('\n');
  return `You keep the campaign journal for a tabletop role-playing campaign called "${campaignName}". Below are the CURRENT JOURNAL and the ${sessionNotesOnly ? 'STRUCTURED NOTES' : 'TRANSCRIPT'} of session ${sessionNumber}${date ? ` (${date.slice(0, 10)})` : ''}.

Speakers are labelled with the players' Discord names. One of them is usually the Game Master, who narrates the world and voices the NPCs. Players: ${attendees.join(', ') || 'unknown'}.

Return the COMPLETE updated journal in Markdown, using exactly these sections in this order:
${sections}

Rules:
- Keep everything already in the journal unless this session clearly contradicts or resolves it. Never drop an entry just because it did not come up this session.
- Merge new information into existing entries instead of duplicating them. One bullet per entity, e.g. "- **Name** — who or what they are; relationship to the party; latest status (session ${sessionNumber})."
- Party: map each player to their character (name, ancestry/class, notable traits) when it can be inferred, e.g. "- **Thorin** (played by Alex) — dwarf fighter …". Identify the Game Master here too if clear.
- Mark finished quests "(completed, session N)" and dead characters "(deceased, session N)" instead of deleting them.
- Out-of-character table talk (rules lookups, snacks, scheduling, jokes) does not belong in the journal.
- Speech-to-text garbles fantasy names. When a name in the transcript is clearly an entity already in the journal, use the journal's spelling.
- Preserve uncertainty. Keep disputed or unclear details under Open Mysteries and leave an attribution unknown when several people share one microphone. Never promote a guess from the session notes to a confirmed fact.
- Do not add a session-by-session log; that is kept separately.
- Output only the journal Markdown: no preamble, no closing remarks, no code fences.${summaryLanguageInstruction(summaryLanguage).replace('summary', 'journal')}
${tldr ? `\nThis session's summary, for orientation: ${tldr}\n` : ''}
<current_journal>
${journal?.trim() || EMPTY_JOURNAL}
</current_journal>

<session_material>
${transcript}
</session_material>`;
}

// Models sometimes wrap the document in a fence or add a sentence before it.
export function cleanJournal(raw = '') {
  let text = String(raw).trim();
  const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();
  const firstHeading = text.search(/^## /m);
  if (firstHeading > 0) text = text.slice(firstHeading);
  return text.trim();
}

const JOURNAL_MAX_CHARS = 8500; // longest journal an automatic update will rewrite
const CONTEXT_JOURNAL_CHARS = 3500; // journal background given to the summarizer
const SESSION_MATERIAL_CHARS = 6500; // transcript sent as-is up to this size
const SESSION_NOTES_CHARS = 5600; // structured-notes budget for longer sessions

const headingsOf = (text) => [...String(text || '').matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
const headingKey = (heading) => heading.replace(/\s+/g, ' ').trim().toLowerCase();

// Guard against a model reply that would wipe out the journal: a refusal, an
// error string, or a truncated rewrite. Throws with a readable reason.
export function checkJournalUpdate(previous, next) {
  if (!/^## /m.test(next)) {
    throw new Error('The model did not return a journal (no sections found).');
  }
  const prev = (previous || '').trim();
  if (prev.length > 800 && next.length < prev.length * 0.5) {
    throw new Error(`The model's journal was less than half the length of the current one (${next.length} vs ${prev.length} characters), so it was rejected to avoid losing notes.`);
  }
  // A reply cut off mid-way loses whole trailing sections while staying long
  // enough to pass the length check.
  const kept = new Set(headingsOf(next).map(headingKey));
  const missing = headingsOf(prev).filter((h) => !kept.has(headingKey(h)));
  if (missing.length) {
    throw new Error(`The model's journal is missing ${missing.map((h) => `"${h}"`).join(', ')} from the current one (the reply was probably cut off), so it was rejected to avoid losing notes.`);
  }
}

const OMITTED_ENTRIES = '- … (more entries not shown)';

// A section cut to whole lines; the heading always stays.
function clipSection(section, limit) {
  if (section.length <= limit) return section;
  const [heading, ...lines] = section.split('\n');
  const kept = [heading];
  let used = heading.length + 1 + OMITTED_ENTRIES.length;
  for (const line of lines) {
    if (used + line.length + 1 > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, OMITTED_ENTRIES].join('\n');
}

/**
 * The journal cut to about `budget` characters for a prompt without dropping
 * whole sections or cutting an entry in half: every '## ' section keeps its
 * heading, small sections stay complete and large ones share what is left,
 * losing their last entries.
 */
export function trimJournal(journal, budget) {
  const text = (journal || '').trim();
  if (text.length <= budget) return text;
  const sections = text.split(/\n+(?=## )/).map((s) => s.trim()).filter(Boolean);
  const limits = new Array(sections.length);
  let remaining = budget - 2 * (sections.length - 1);
  const smallestFirst = sections.map((_, i) => i).sort((a, b) => sections[a].length - sections[b].length);
  smallestFirst.forEach((index, rank) => {
    limits[index] = Math.min(sections[index].length, Math.floor(remaining / (sections.length - rank)));
    remaining -= limits[index];
  });
  return sections.map((section, i) => clipSection(section, limits[i])).join('\n\n');
}

// One update at a time per campaign: two sessions finishing together must not
// both read the old journal and overwrite each other's additions.
const locks = new Map();
export function withCampaignLock(campaignId, fn) {
  const prev = locks.get(campaignId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(campaignId, tail);
  tail.then(() => { if (locks.get(campaignId) === tail) locks.delete(campaignId); });
  return run;
}

// The journal to give the summarizer as background for a session, if any.
export function campaignContextFor(db, meeting) {
  if (!meeting?.campaign_id) return undefined;
  const journal = db.getCampaign(meeting.campaign_id)?.journal;
  return trimJournal(journal, CONTEXT_JOURNAL_CHARS) || undefined;
}

function toPipelineUtterances(rows) {
  return rows.map((u) => ({
    userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
  }));
}

// The start and the end of a long transcript, cut at line boundaries.
function clipMiddle(text, budget) {
  const marker = '\n[… the middle of this session is omitted …]\n';
  const half = Math.floor((budget - marker.length) / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head.slice(0, head.lastIndexOf('\n') + 1 || head.length).trimEnd()}${marker}${tail.slice(tail.indexOf('\n') + 1)}`;
}

function boundedSessionMaterial(utterances, notes) {
  const transcript = buildTranscript(toPipelineUtterances(utterances));
  if (transcript.length <= SESSION_MATERIAL_CHARS) return { transcript };
  const topics = notes?.topics ?? [];
  // No structured notes to condense (e.g. a schema-less model returned none):
  // the opening and the ending of the session still beat skipping it forever.
  if (!topics.length) return { transcript: clipMiddle(transcript, SESSION_MATERIAL_CHARS) };
  const maxPerTopic = Math.max(1, Math.floor(SESSION_NOTES_CHARS / topics.length));
  return {
    sessionNotesOnly: true,
    transcript: topics.map(({ title, points }) => `- ${title}: ${(points ?? []).join(' ')}`.slice(0, maxPerTopic)).join('\n'),
  };
}

function checkJournalSize(journal) {
  if (!(journal?.length > JOURNAL_MAX_CHARS)) return;
  throw new Error(`The journal is too long for an automatic update (${journal.length} characters; the limit is ${JOURNAL_MAX_CHARS}). Shorten it on the Campaigns page, e.g. by condensing finished quests and minor NPCs, then click Update journal.`);
}

function journalErrorReason(err, cfg) {
  return err.userMessage || (err.status ? describeSummarizerError(err, cfg.summarizerProvider) : err.message);
}

// What folding a session needs, or why it is skipped.
function foldTarget(db, meetingId, draft) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting?.campaign_id) return { skipped: 'not in a campaign' };
  if (!draft && meeting.journaled_at) return { skipped: 'already in the journal' };
  const campaign = db.getCampaign(meeting.campaign_id);
  if (!campaign) return { skipped: 'campaign not found' };
  const utterances = db.listUtterances(meetingId);
  if (utterances.length === 0) return { skipped: 'no transcript' };
  return { meeting, campaign, utterances };
}

// Fold one finished session into its campaign's journal (caller holds the lock).
async function foldIntoJournal(db, { meeting, campaign, utterances }, { cfg, summarizer, draft, sessions }) {
  const session = (sessions ?? db.listCampaignSessions(campaign.id)).find((s) => s.id === meeting.id);
  const previous = draft ? draft.journal : campaign.journal;
  checkJournalSize(previous);
  const prompt = buildJournalUpdatePrompt({
    campaignName: campaign.name,
    journal: previous,
    ...boundedSessionMaterial(utterances, session?.notes),
    sessionNumber: session?.number ?? '?',
    date: meeting.started_at,
    attendees: db.listAttendees(meeting.id).map((a) => a.display_name),
    tldr: session?.notes?.tldr,
    summaryLanguage: resolveSummaryLanguage(cfg),
  });
  const next = cleanJournal(await summarizer.ask(prompt));
  checkJournalUpdate(previous, next);
  if (db.getCampaign(campaign.id)?.journal !== campaign.journal || db.getMeeting(meeting.id)?.campaign_id !== campaign.id) {
    throw new Error('The journal or session changed during the update. Run Update journal again.');
  }
  if (draft) {
    draft.journal = next;
    draft.meetingIds.push(meeting.id);
  } else {
    db.setCampaignJournal(campaign.id, next);
    db.markJournaled(meeting.id);
  }
  return { updated: true, campaignId: campaign.id };
}

/**
 * Fold one finished session into its campaign's journal. A no-op (returns
 * { skipped }) for meetings outside a campaign or already folded in. While it
 * runs campaigns.journal_status is 'updating'; a failure is recorded there as
 * 'error' so it shows on the Campaigns page instead of only in the log.
 */
export function foldMeetingIntoJournal(db, meetingId, { cfg, summarizer, env } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting?.campaign_id) return Promise.resolve({ skipped: 'not in a campaign' });
  const c = cfg || getGuildConfig(db, meeting.guild_id);
  const s = summarizer || getSummarizer(c, env);
  return withCampaignLock(meeting.campaign_id, async () => {
    const target = foldTarget(db, meetingId, null);
    if (target.skipped) return target;
    const campaignId = target.campaign.id;
    db.setJournalStatus(campaignId, 'updating');
    try {
      const result = await foldIntoJournal(db, target, { cfg: c, summarizer: s });
      db.setJournalStatus(campaignId, 'idle');
      return result;
    } catch (err) {
      db.setJournalStatus(campaignId, 'error', journalErrorReason(err, c));
      throw err;
    }
  });
}

function commitRebuild(db, campaignId, draft) {
  db.sql.exec('BEGIN');
  try {
    db.setCampaignJournal(campaignId, draft.journal);
    db.clearJournaled(campaignId);
    for (const id of draft.meetingIds) db.markJournaled(id);
    db.sql.exec('COMMIT');
  } catch (error) {
    db.sql.exec('ROLLBACK');
    throw error;
  }
}

// Fold pending sessions oldest first, stopping at the first failure (order
// matters: each fold builds on the previous journal). Folds before a failure
// are kept, except in a rebuild, which commits all or nothing.
async function foldPending(db, campaignId, { rebuild, cfg, summarizer }) {
  const draft = rebuild ? { journal: null, meetingIds: [] } : null;
  const sessions = db.listCampaignSessions(campaignId);
  const pending = sessions.filter((m) => m.status === 'done' && (rebuild || !m.journaled_at));
  let folded = 0;
  for (const m of pending) {
    try {
      const r = await foldUnlocked(db, m.id, { cfg, summarizer, draft, sessions });
      if (r.updated) folded++;
    } catch (error) {
      const progress = rebuild
        ? `The rebuild stopped at session ${m.number} and the journal was left unchanged`
        : `Updated the journal with ${folded} of ${pending.length} sessions; session ${m.number} failed`;
      return { folded, error, reason: `${progress}: ${journalErrorReason(error, cfg)}` };
    }
  }
  if (draft?.meetingIds.length) commitRebuild(db, campaignId, draft);
  return { folded };
}

function foldUnlocked(db, meetingId, opts) {
  const target = foldTarget(db, meetingId, opts.draft);
  return target.skipped ? Promise.resolve(target) : foldIntoJournal(db, target, opts);
}

/**
 * Fold every finished session that isn't in the journal yet, oldest first.
 * With rebuild, start over from an empty journal (hand edits are lost).
 * Tracks progress in campaigns.journal_status so the UI can show it.
 */
export function catchUpJournal(db, campaignId, { rebuild = false, cfg, summarizer, env } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return Promise.reject(new Error('campaign not found'));
  const c = cfg || getGuildConfig(db, campaign.guild_id);
  const s = summarizer || getSummarizer(c, env);
  db.setJournalStatus(campaignId, 'updating');
  return withCampaignLock(campaignId, async () => {
    // An automatic fold queued ahead of this one may have reset the status.
    db.setJournalStatus(campaignId, 'updating');
    let result;
    try {
      result = await foldPending(db, campaignId, { rebuild, cfg: c, summarizer: s });
    } catch (err) {
      db.setJournalStatus(campaignId, 'error', journalErrorReason(err, c));
      throw err;
    }
    if (result.error) {
      db.setJournalStatus(campaignId, 'error', result.reason);
      throw result.error;
    }
    db.setJournalStatus(campaignId, 'idle');
    return { folded: result.folded };
  });
}
