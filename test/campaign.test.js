import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { apiRouter } from '../src/web/api.js';
import { setGuildConfig } from '../src/store/config.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { summaryPrompt, SUMMARY_PROMPT } from '../src/adapters/summarizer/notes.js';
import {
  cleanJournal, checkJournalUpdate, foldMeetingIntoJournal, catchUpJournal, withCampaignLock,
  campaignContextFor, buildJournalUpdatePrompt,
} from '../src/campaign/journal.js';
import {
  extractTerms, ftsQuery, askCampaign, recapCampaign, resolveCampaign, sessionNotesBlock, transcriptExcerpts,
} from '../src/campaign/ask.js';
import { campaignChoices } from '../src/commands/autocomplete.js';

const CFG = { summarizerProvider: 'fake', summaryLanguage: 'en' };
const JOURNAL = '## Party\n- **Thorin** (played by Alex) — dwarf fighter\n\n## NPCs\n- **Strahd** — vampire lord';

// A summarizer whose ask() records prompts and replies with a canned journal.
function recorder(reply = JOURNAL) {
  const s = new FakeSummarizer();
  s.prompts = [];
  s.ask = async (p) => { s.prompts.push(p); return typeof reply === 'function' ? reply(p, s.prompts.length) : reply; };
  return s;
}

function session(db, { guildId = 'g', channelId = 'vc', startedAt, lines = [], done = true }) {
  const id = db.createMeeting({ guildId, channelId, channelName: 'dnd', startedAt });
  db.addAttendee(id, 'u1', 'Alex');
  let t = Date.parse(startedAt);
  for (const text of lines) {
    db.addUtterance({ meetingId: id, userId: 'u1', displayName: 'Alex', startMs: t, endMs: t + 1000, text });
    t += 5000;
  }
  if (done) {
    db.saveSummary(id, { tldr: `tldr ${startedAt}`, topics: [{ title: 'Fight', points: ['won'] }], decisions: [], openQuestions: [], actionItems: [] }, [], 'fake');
    db.setMeetingStatus(id, 'done');
  }
  return id;
}

test('a meeting recorded in a linked voice channel joins the campaign', () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'Curse of Strahd' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc', channelName: 'dnd' });
  const inCampaign = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-01' });
  const elsewhere = db.createMeeting({ guildId: 'g', channelId: 'other', channelName: 'work', startedAt: '2026-01-01' });
  assert.equal(db.getMeeting(inCampaign).campaign_id, cid);
  assert.equal(db.getMeeting(elsewhere).campaign_id, null);
});

test('includePast attaches earlier unassigned recordings from the channel only', () => {
  const db = openDb(':memory:');
  const a = db.createCampaign({ guildId: 'g', name: 'A' });
  const b = db.createCampaign({ guildId: 'g', name: 'B' });
  const past = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-01' });
  const taken = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-02' });
  db.setMeetingCampaign(taken, b);
  const otherChannel = db.createMeeting({ guildId: 'g', channelId: 'x', channelName: 'x', startedAt: '2026-01-03' });
  assert.equal(db.linkCampaignChannel(a, { guildId: 'g', channelId: 'vc', includePast: true }), 1);
  assert.equal(db.getMeeting(past).campaign_id, a);
  assert.equal(db.getMeeting(taken).campaign_id, b);
  assert.equal(db.getMeeting(otherChannel).campaign_id, null);
});

test('sessions are numbered oldest-first; moving a session clears its journaled mark', () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const s2 = session(db, { startedAt: '2026-02-01T19:00:00Z' });
  const s1 = session(db, { startedAt: '2026-01-01T19:00:00Z' });
  const nums = db.listCampaignSessions(cid).map((s) => [s.id, s.number]);
  assert.deepEqual(nums, [[s1, 1], [s2, 2]]);
  db.markJournaled(s1);
  db.setMeetingCampaign(s1, cid); // same campaign: mark kept
  assert.ok(db.getMeeting(s1).journaled_at);
  const other = db.createCampaign({ guildId: 'g', name: 'D' });
  db.setMeetingCampaign(s1, other);
  assert.equal(db.getMeeting(s1).journaled_at, null);
});

test('deleting a campaign keeps its sessions but unlinks them', () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z' });
  db.deleteCampaign(cid);
  assert.equal(db.getCampaign(cid), null);
  assert.equal(db.getMeeting(id).campaign_id, null);
  assert.equal(db.campaignForChannel('vc'), null);
});

test('summaryPrompt appends the campaign background only when present', () => {
  assert.equal(summaryPrompt({}), SUMMARY_PROMPT);
  const p = summaryPrompt({ campaignContext: JOURNAL, summaryPrompt: 'CUSTOM' });
  assert.ok(p.startsWith('CUSTOM'));
  assert.match(p, /<campaign_background>[\s\S]*Strahd[\s\S]*<\/campaign_background>/);
});

test('cleanJournal strips fences and preamble', () => {
  assert.equal(cleanJournal('```markdown\n## Party\n- x\n```'), '## Party\n- x');
  assert.equal(cleanJournal('Here is the updated journal:\n\n## Party\n- x'), '## Party\n- x');
});

test('checkJournalUpdate rejects non-journals and drastic shrinkage', () => {
  assert.throws(() => checkJournalUpdate('', 'Sorry, I cannot help.'), /no sections/);
  const long = `## Party\n${'- entry\n'.repeat(200)}`;
  assert.throws(() => checkJournalUpdate(long, '## Party\n- one'), /less than half/);
  assert.doesNotThrow(() => checkJournalUpdate(long, long + '- more'));
});

test('journal prompt keeps the current journal and names the session', () => {
  const p = buildJournalUpdatePrompt({ campaignName: 'C', journal: JOURNAL, transcript: 'Alex: hi', sessionNumber: 3, date: '2026-03-01T00:00:00Z', summaryLanguage: 'en' });
  assert.match(p, /session 3 \(2026-03-01\)/);
  assert.match(p, /<current_journal>\n## Party/);
  assert.match(p, /Write the entire journal in English/);
});

test('foldMeetingIntoJournal updates the journal once and skips non-campaign meetings', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['We meet Strahd.'] });
  const loose = session(db, { channelId: 'x', startedAt: '2026-01-02T19:00:00Z', lines: ['hi'] });
  const s = recorder();
  assert.deepEqual(await foldMeetingIntoJournal(db, loose, { cfg: CFG, summarizer: s }), { skipped: 'not in a campaign' });
  const r = await foldMeetingIntoJournal(db, id, { cfg: CFG, summarizer: s });
  assert.equal(r.updated, true);
  assert.equal(db.getCampaign(cid).journal, JOURNAL);
  assert.ok(db.getMeeting(id).journaled_at);
  assert.match(s.prompts[0], /We meet Strahd\./);
  assert.equal((await foldMeetingIntoJournal(db, id, { cfg: CFG, summarizer: s })).skipped, 'already in the journal');
  assert.equal(s.prompts.length, 1);
});

test('a rejected journal update leaves the old journal and the session unjournaled', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  db.setCampaignJournal(cid, JOURNAL);
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['x'] });
  await assert.rejects(foldMeetingIntoJournal(db, id, { cfg: CFG, summarizer: recorder('I cannot do that.') }), /no sections/);
  assert.equal(db.getCampaign(cid).journal, JOURNAL);
  assert.equal(db.getMeeting(id).journaled_at, null);
});

test('catchUpJournal folds pending sessions oldest first; rebuild starts over', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  session(db, { startedAt: '2026-02-01T19:00:00Z', lines: ['second session'] });
  session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['first session'] });
  session(db, { startedAt: '2026-03-01T19:00:00Z', lines: ['still recording'], done: false });
  const s = recorder((_p, n) => `## Party\n- after ${n}`);
  assert.deepEqual(await catchUpJournal(db, cid, { cfg: CFG, summarizer: s }), { folded: 2 });
  assert.match(s.prompts[0], /first session/);
  assert.match(s.prompts[1], /second session/);
  assert.match(s.prompts[1], /- after 1/); // second fold sees the first result
  assert.equal(db.getCampaign(cid).journal_status, 'idle');
  assert.deepEqual(await catchUpJournal(db, cid, { cfg: CFG, summarizer: s }), { folded: 0 });
  db.setCampaignJournal(cid, '## Party\n- hand edit');
  await catchUpJournal(db, cid, { rebuild: true, cfg: CFG, summarizer: s });
  assert.equal(s.prompts.length, 4);
  assert.doesNotMatch(s.prompts[2], /hand edit/);
});

test('catchUpJournal records an error status on failure', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['x'] });
  const s = recorder();
  s.ask = async () => { throw new Error('provider down'); };
  await assert.rejects(catchUpJournal(db, cid, { cfg: CFG, summarizer: s }), /provider down/);
  const c = db.getCampaign(cid);
  assert.equal(c.journal_status, 'error');
  assert.match(c.journal_error, /provider down/);
});

test('withCampaignLock runs updates for one campaign one at a time', async () => {
  const order = [];
  const slow = (tag, ms) => () => new Promise((r) => setTimeout(() => { order.push(tag); r(tag); }, ms));
  await Promise.all([withCampaignLock(1, slow('a', 30)), withCampaignLock(1, slow('b', 1))]);
  assert.deepEqual(order, ['a', 'b']);
});

test('processMeeting feeds the journal into the summary and folds the session in', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  db.setCampaignJournal(cid, JOURNAL);
  const id = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-01T19:00:00Z' });
  const s = recorder(`${JOURNAL}\n- **Ireena** — new friend`);
  let seenMeta;
  const summarize = s.summarize.bind(s);
  s.summarize = async (t, meta) => { seenMeta = meta; return summarize(t, meta); };
  const result = await processMeeting(db, id, {
    tracks: [], cfg: CFG, summarizer: s,
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alex', startMs: 0, endMs: 1000, text: 'We rescue Ireena.' }], failures: [] }),
  });
  assert.equal(seenMeta.campaignContext, JOURNAL);
  assert.equal(result.journal.updated, true);
  assert.match(db.getCampaign(cid).journal, /Ireena/);
  assert.equal(campaignContextFor(db, db.getMeeting(id)), db.getCampaign(cid).journal);
});

test('processMeeting still succeeds when the journal update fails', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const id = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-01T19:00:00Z' });
  const result = await processMeeting(db, id, {
    tracks: [], cfg: CFG, summarizer: new FakeSummarizer(), // ask() returns non-journal text
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alex', startMs: 0, endMs: 1000, text: 'hi' }], failures: [] }),
  });
  assert.equal(db.getMeeting(id).status, 'done');
  assert.ok(result.journal.error);
  assert.equal(db.getMeeting(id).journaled_at, null);
});

test('extractTerms drops stopwords and short words; ftsQuery escapes and prefixes', () => {
  assert.deepEqual(extractTerms('When did the party first meet Strahd\'s brother?'), ['meet', 'strahd', 'brother']);
  assert.equal(ftsQuery(['say "hi"', 'orc']), '"say ""hi"""* OR "orc"*');
});

test('sessionNotesBlock trims older sessions to their TL;DR when over budget', () => {
  const mk = (n) => ({ number: n, started_at: `2026-0${n}-01`, notes: { tldr: `tl${n}`, topics: [{ title: 'T', points: ['x'.repeat(200)] }] } });
  const block = sessionNotesBlock([mk(1), mk(2), mk(3)], 500);
  assert.match(block, /Session 1 — 2026-01-01\ntl1(?!\n- T)/);
  assert.match(block, /Session 3[\s\S]*- T: x/); // newest keeps its detail
});

test('askCampaign grounds the prompt in journal, notes and matching transcript passages', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'Curse of Strahd' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  db.setCampaignJournal(cid, JOURNAL);
  session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['We roll initiative.', 'The amulet glows red.'] });
  session(db, { startedAt: '2026-02-01T19:00:00Z', lines: ['Nothing relevant here.'] });
  const s = recorder('It glowed red (Session 1).');
  const answer = await askCampaign(db, cid, 'What happened with the amulet?', { cfg: CFG, summarizer: s });
  assert.equal(answer, 'It glowed red (Session 1).');
  const p = s.prompts[0];
  assert.match(p, /<campaign_journal>\n## Party/);
  assert.match(p, /### Session 2 — 2026-02-01/);
  assert.match(p, /\[Session 1, around 00:00\]\nAlex: We roll initiative\.\nAlex: The amulet glows red\./);
  assert.doesNotMatch(p, /Nothing relevant here/);
});

test('recapCampaign covers the requested recent sessions and the end of the last one', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  await assert.rejects(recapCampaign(db, cid, { cfg: CFG, summarizer: recorder() }), /no summarized sessions/);
  session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['old'] });
  session(db, { startedAt: '2026-02-01T19:00:00Z', lines: ['The door slams shut!'] });
  const s = recorder('Previously…');
  await recapCampaign(db, cid, { sessions: 1, cfg: CFG, summarizer: s });
  assert.match(s.prompts[0], /Session 2/);
  assert.doesNotMatch(s.prompts[0], /### Session 1/);
  assert.match(s.prompts[0], /The door slams shut!/);
});

test('resolveCampaign: explicit id/name, then linked voice channel, then most recent', () => {
  const db = openDb(':memory:');
  const a = db.createCampaign({ guildId: 'g', name: 'Curse of Strahd' });
  const b = db.createCampaign({ guildId: 'g', name: 'Tomb of Annihilation' });
  db.linkCampaignChannel(a, { guildId: 'g', channelId: 'vc' });
  // A campaign's activity is its latest session, or its creation if it has none.
  session(db, { channelId: 'x', startedAt: '2099-05-01T19:00:00Z' });
  db.setMeetingCampaign(db.listRecent('g', 1)[0].id, b);
  assert.equal(resolveCampaign(db, 'g', { campaign: String(a) }).id, a);
  assert.equal(resolveCampaign(db, 'g', { campaign: 'tomb' }).id, b);
  assert.equal(resolveCampaign(db, 'g', { voiceChannelId: 'vc' }).id, a);
  assert.equal(resolveCampaign(db, 'g', {}).id, b); // most recently active
  assert.equal(resolveCampaign(db, 'other', {}), null);
  assert.deepEqual(campaignChoices(db, 'g', 'strahd'), [{ name: 'Curse of Strahd', value: String(a) }]);
});

test('merging a journaled session into another keeps it out of a second fold', () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const a = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['a'] });
  const b = session(db, { startedAt: '2026-01-01T20:00:00Z', lines: ['b'] });
  db.markJournaled(b);
  db.mergeMeetings(a, [b]);
  assert.ok(db.getMeeting(a).journaled_at);
});

// ── API ──────────────────────────────────────────────────────────────────
async function listen(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const send = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('campaign API: create with channel, list, detail, edit journal, move sessions, ask', async () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'fake' });
  const past = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['We found the amulet.'] });
  const loose = session(db, { channelId: 'other', startedAt: '2026-01-02T19:00:00Z', lines: ['work stuff'] });
  const { base, close } = await listen(db);
  try {
    let res = await fetch(`${base}/api/guilds/g/campaigns`, send('POST', { name: '  Strahd  ', channelId: 'vc', channelName: 'dnd', includePast: true }));
    const created = await res.json();
    assert.equal(created.campaign.name, 'Strahd');
    assert.equal(created.attached, 1);
    const id = created.campaign.id;

    const list = await (await fetch(`${base}/api/guilds/g/campaigns`)).json();
    assert.equal(list[0].session_count, 1);
    assert.equal(list[0].pending_count, 1);
    assert.equal(list[0].journal, undefined);

    const voice = await (await fetch(`${base}/api/guilds/g/voice-channels`)).json();
    assert.equal(voice.find((v) => v.id === 'vc').campaignId, id);

    let detail = await (await fetch(`${base}/api/campaigns/${id}`)).json();
    assert.deepEqual(detail.sessions.map((s) => s.id), [past]);
    assert.deepEqual(detail.unassigned.map((m) => m.id), [loose]);

    res = await fetch(`${base}/api/campaigns/${id}`, send('PATCH', { journal: JOURNAL }));
    assert.equal(res.status, 200);
    assert.equal(db.getCampaign(id).journal, JOURNAL);

    res = await fetch(`${base}/api/meetings/${loose}/campaign`, send('PUT', { campaignId: id }));
    assert.equal(res.status, 200);
    detail = await (await fetch(`${base}/api/campaigns/${id}`)).json();
    assert.equal(detail.sessions.length, 2);

    const ask = await (await fetch(`${base}/api/campaigns/${id}/ask`, send('POST', { question: 'amulet?' }))).json();
    assert.match(ask.answer, /Fake answer/);
    assert.equal((await fetch(`${base}/api/campaigns/${id}/ask`, send('POST', { question: ' ' }))).status, 400);

    res = await fetch(`${base}/api/campaigns/${id}/channels/vc`, { method: 'DELETE' });
    assert.deepEqual((await res.json()).channels, []);
    res = await fetch(`${base}/api/campaigns/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(db.getMeeting(past).campaign_id, null);
    assert.equal((await fetch(`${base}/api/campaigns/${id}`)).status, 404);
  } finally { close(); }
});

test('campaign API: journal update runs in the background and refuses to overlap', async () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'fake' });
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.setJournalStatus(cid, 'updating');
  const { base, close } = await listen(db);
  try {
    assert.equal((await fetch(`${base}/api/campaigns/${cid}/journal/update`, send('POST', {}))).status, 409);
    assert.equal((await fetch(`${base}/api/campaigns/${cid}`, send('PATCH', { journal: 'x' }))).status, 409);
    db.setJournalStatus(cid, 'idle');
    const res = await fetch(`${base}/api/campaigns/${cid}/journal/update`, send('POST', {}));
    assert.equal(res.status, 202);
  } finally { close(); }
});

// ── Journal robustness ───────────────────────────────────────────────────
const bigJournal = (perSection = 40) => ['Party', 'NPCs', 'Locations', 'Quests & Plot Threads', 'Items & Loot', 'Lore & World', 'Open Mysteries']
  .map((s) => `## ${s}\n${Array.from({ length: perSection }, (_, i) => `- **${s} entry ${i}** — some detail about it`).join('\n')}`)
  .join('\n\n');

test('checkJournalUpdate rejects a rewrite that drops a section of the current journal', () => {
  const prev = '## Party\n- a\n\n## NPCs\n- b\n\n## Locations\n- c';
  assert.throws(() => checkJournalUpdate(prev, '## Party\n- a\n\n## NPCs\n- b'), /Locations/);
  assert.doesNotThrow(() => checkJournalUpdate(prev, '## party \n- a\n\n## NPCs\n- b\n- new\n\n## Locations\n- c'));
  assert.doesNotThrow(() => checkJournalUpdate('', '## Party\n- first fold'));
});

test('a long session without topics still folds, from a clipped transcript', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'words '.repeat(6)}`);
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z', lines });
  db.saveSummary(id, { tldr: 'They fought', topics: [], decisions: [], openQuestions: [], actionItems: [] }, [], 'fake');
  const s = recorder();
  assert.deepEqual(await catchUpJournal(db, cid, { cfg: CFG, summarizer: s }), { folded: 1 });
  const material = s.prompts[0].split('<session_material>')[1];
  assert.ok(material.length < 7500);
  assert.match(material, /line 0 /);
  assert.match(material, /line 299 /); // the end of the session is kept too
  assert.match(material, /omitted/);
  assert.ok(db.getMeeting(id).journaled_at);
});

test('catchUpJournal reports partial progress when a later session fails', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const first = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['one'] });
  const second = session(db, { startedAt: '2026-02-01T19:00:00Z', lines: ['two'] });
  const s = recorder((_p, n) => { if (n === 2) throw new Error('provider down'); return '## Party\n- one'; });
  await assert.rejects(catchUpJournal(db, cid, { cfg: CFG, summarizer: s }), /provider down/);
  const c = db.getCampaign(cid);
  assert.equal(c.journal_status, 'error');
  assert.match(c.journal_error, /1 of 2 sessions/);
  assert.match(c.journal_error, /session 2/i);
  assert.match(c.journal_error, /provider down/);
  assert.ok(db.getMeeting(first).journaled_at);
  assert.equal(db.getMeeting(second).journaled_at, null);
});

test('catchUpJournal lists the campaign sessions once, not once per folded session', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  for (let m = 1; m <= 4; m++) session(db, { startedAt: `2026-0${m}-01T19:00:00Z`, lines: [`s${m}`] });
  let calls = 0;
  const list = db.listCampaignSessions.bind(db);
  db.listCampaignSessions = (id) => { calls++; return list(id); };
  assert.deepEqual(await catchUpJournal(db, cid, { cfg: CFG, summarizer: recorder() }), { folded: 4 });
  assert.equal(calls, 1);
});

test('the automatic fold shows journal_status updating while it runs, then idle', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['x'] });
  let during;
  const s = recorder((p) => { during = db.getCampaign(cid).journal_status; return JOURNAL; });
  await foldMeetingIntoJournal(db, id, { cfg: CFG, summarizer: s });
  assert.equal(during, 'updating');
  assert.equal(db.getCampaign(cid).journal_status, 'idle');
});

test('a failed automatic fold leaves a visible, actionable journal error', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  db.setCampaignJournal(cid, bigJournal(60));
  const id = db.createMeeting({ guildId: 'g', channelId: 'vc', channelName: 'dnd', startedAt: '2026-01-01T19:00:00Z' });
  const result = await processMeeting(db, id, {
    tracks: [], cfg: CFG, summarizer: recorder(),
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alex', startMs: 0, endMs: 1000, text: 'hi' }], failures: [] }),
  });
  assert.match(result.journal.error, /too long/);
  const c = db.getCampaign(cid);
  assert.equal(c.journal_status, 'error');
  assert.match(c.journal_error, /characters/);
  assert.match(c.journal_error, /Update journal/);
});

test('journal excerpts fed to prompts keep every section and whole entries', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  db.setCampaignJournal(cid, bigJournal());
  const id = session(db, { startedAt: '2026-01-01T19:00:00Z', lines: ['the amulet'] });
  const context = campaignContextFor(db, db.getMeeting(id));
  assert.ok(context.length <= 3500, `context is ${context.length} chars`);
  for (const line of context.split('\n')) {
    assert.ok(line === '' || /^## /.test(line) || /^- \*\*.+ entry \d+\*\* — some detail about it$/.test(line) || /^- …/.test(line), `cut entry: ${line}`);
  }
  assert.match(context, /## Open Mysteries\n- \*\*Open Mysteries entry 0\*\*/);
  const s = recorder('ok');
  await askCampaign(db, cid, 'What about the amulet?', { cfg: CFG, summarizer: s });
  await recapCampaign(db, cid, { cfg: CFG, summarizer: s });
  for (const p of s.prompts) {
    const journal = p.split('<campaign_journal>')[1].split('</campaign_journal>')[0];
    assert.ok(journal.length <= 4100);
    assert.match(journal, /## Open Mysteries\n- \*\*Open Mysteries entry 0\*\*/);
  }
});

// ── Campaign Q&A excerpts ────────────────────────────────────────────────
function excerptDb(rows, ranked) {
  return {
    searchCampaignUtterances: () => ranked,
    firstUtteranceMs: (id) => Math.min(...rows.filter((u) => u.meeting_id === id).map((u) => u.start_ms)),
    utterancesBetween: (id, from, to) => rows.filter((u) => u.meeting_id === id && u.start_ms >= from && u.start_ms <= to),
  };
}

test('transcriptExcerpts keeps the best match even when an older window is over budget', () => {
  const monologue = { meeting_id: 1, start_ms: 1000, display_name: 'GM', text: 'dragon '.repeat(700) };
  const best = { meeting_id: 9, start_ms: 5000, display_name: 'Ann', text: 'We killed the dragon Vex at the bridge.' };
  const db = excerptDb([monologue, best], [best, monologue]); // bm25: session 9 first
  const out = transcriptExcerpts(db, 7, 'who killed the dragon', [{ id: 1, number: 1 }, { id: 9, number: 9 }], 4000);
  assert.match(out, /\[Session 9, around 00:00\]\nAnn: We killed the dragon Vex/);
  assert.ok(out.length <= 4000);
});

test('transcriptExcerpts picks by rank, then shows the kept passages in session order', () => {
  const rows = [
    { meeting_id: 1, start_ms: 0, display_name: 'Al', text: 'the amulet was found' },
    { meeting_id: 2, start_ms: 0, display_name: 'Bo', text: 'the amulet glows' },
  ];
  const out = transcriptExcerpts(excerptDb(rows, [rows[1], rows[0]]), 7, 'amulet', [{ id: 1, number: 1 }, { id: 2, number: 2 }], 4000);
  assert.ok(out.indexOf('[Session 1') < out.indexOf('[Session 2'));
  assert.ok(out.indexOf('[Session 1') >= 0);
});

test('transcriptExcerpts clips an oversize window to the lines nearest the match', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ meeting_id: 1, start_ms: i * 1000, display_name: 'GM', text: i === 25 ? 'the amulet shatters' : `filler line number ${i} ${'x'.repeat(40)}` }));
  const out = transcriptExcerpts(excerptDb(rows, [rows[25]]), 7, 'amulet', [{ id: 1, number: 1 }], 600);
  assert.ok(out.length > 0 && out.length <= 600, `length ${out.length}`);
  assert.match(out, /GM: the amulet shatters/);
  assert.match(out, /filler line number 24 /);
  assert.doesNotMatch(out, /filler line number 0 /);
});

test('recapCampaign reads only the end of the last session, with renamed speakers', async () => {
  const db = openDb(':memory:');
  const cid = db.createCampaign({ guildId: 'g', name: 'C' });
  db.linkCampaignChannel(cid, { guildId: 'g', channelId: 'vc' });
  session(db, { startedAt: '2026-01-01T19:00:00Z', lines: Array.from({ length: 100 }, (_, i) => `line ${i}`).concat('The door slams shut!') });
  db.setSpeakerName('g', 'u1', 'Alexandra');
  db.listUtterances = () => { throw new Error('loaded the whole session'); };
  const asked = [];
  const listLast = db.listLastUtterances.bind(db);
  db.listLastUtterances = (id, n) => { asked.push(n); return listLast(id, n); };
  const s = recorder('Previously…');
  await recapCampaign(db, cid, { cfg: CFG, summarizer: s });
  assert.deepEqual(asked, [60]);
  const tail = s.prompts[0].split('<end_of_last_session>')[1];
  assert.match(tail, /Alexandra: The door slams shut!/);
  assert.doesNotMatch(tail, /line 39\n/);
  assert.match(tail, /line 41\n/);
});
