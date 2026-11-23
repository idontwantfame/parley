// test/db-queries.test.js — pagination, neighbours, scoped unlink, SQL
// aggregates, search robustness and boot-only journal reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { reconcileOnBoot } from '../src/store/reconcile.js';

const quiet = { warn: () => {}, log: () => {} };

function meeting(db, { guildId = 'g', status = 'done', utterances = 1, startedAt = '2026-01-01T00:00:00Z', text = 'hello' } = {}) {
  const id = Number(db.createMeeting({ guildId, channelId: 'c', channelName: 'Voice', startedAt }));
  db.setMeetingStatus(id, status);
  for (let i = 0; i < utterances; i++) {
    db.addUtterance({ meetingId: id, userId: 'u', displayName: 'Al', startMs: i, endMs: i + 1, text });
  }
  return id;
}

test('listRecentRich pages with limit and before', () => {
  const db = openDb(':memory:');
  const ids = [1, 2, 3, 4, 5].map(() => meeting(db));
  meeting(db, { guildId: 'other' });
  assert.deepEqual(db.listRecentRich('g', 2).map((m) => m.id), [ids[4], ids[3]]);
  assert.deepEqual(db.listRecentRich('g', 2, { before: ids[3] }).map((m) => m.id), [ids[2], ids[1]]);
  assert.deepEqual(db.listRecentRich('g', 10, { before: ids[1] }).map((m) => m.id), [ids[0]]);
});

test('meetingNeighbors skips hidden meetings and stays in the guild', () => {
  const db = openDb(':memory:');
  const a = meeting(db, { startedAt: '2026-01-01T00:00:00Z' });
  meeting(db, { guildId: 'other' });
  meeting(db, { utterances: 0 }); // empty → hidden from the list
  const failed = meeting(db, { status: 'transcription_failed', utterances: 0 });
  const b = meeting(db);
  const c = meeting(db, { startedAt: '2026-01-05T00:00:00Z' });
  assert.deepEqual(db.meetingNeighbors(db.getMeeting(b)), {
    older: { id: failed, started_at: '2026-01-01T00:00:00Z' },
    newer: { id: c, started_at: '2026-01-05T00:00:00Z' },
  });
  assert.deepEqual(db.meetingNeighbors(db.getMeeting(a)).older, null);
  assert.deepEqual(db.meetingNeighbors(db.getMeeting(c)).newer, null);
});

test('listMeetingTodos returns the meeting rows with the guild todo columns', () => {
  const db = openDb(':memory:');
  const id = meeting(db);
  const other = meeting(db);
  db.seedTodos(id, 'g', [{ assignee: 'Al', task: 'one' }, { task: 'two' }]);
  db.seedTodos(other, 'g', [{ task: 'elsewhere' }]);
  const rows = db.listMeetingTodos(id);
  assert.deepEqual(rows.map((t) => t.task).sort(), ['one', 'two']);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(db.listTodos('g')[0]).sort());
});

test('listUnassignedMeetings finds old campaign-less meetings directly', () => {
  const db = openDb(':memory:');
  const old = meeting(db);
  const campaign = db.createCampaign({ guildId: 'g', name: 'C' });
  for (let i = 0; i < 5; i++) db.setMeetingCampaign(meeting(db), campaign);
  meeting(db, { status: 'empty', utterances: 0 });
  db.saveSummary(old, { tldr: 'first' }, [], 'm');
  const rows = db.listUnassignedMeetings('g', 3);
  assert.deepEqual(rows.map((m) => m.id), [old]);
  assert.equal(rows[0].tldr, 'first');
});

test('unlinkCampaignChannel only removes the link from the given campaign', () => {
  const db = openDb(':memory:');
  const a = db.createCampaign({ guildId: 'g', name: 'A' });
  const b = db.createCampaign({ guildId: 'g', name: 'B' });
  db.linkCampaignChannel(a, { guildId: 'g', channelId: 'voice' });
  assert.equal(db.unlinkCampaignChannel(b, 'voice'), false);
  assert.equal(db.listCampaignChannels(a).length, 1);
  assert.equal(db.unlinkCampaignChannel(a, 'voice'), true);
  assert.equal(db.listCampaignChannels(a).length, 0);
});

test('stats aggregates tolerate malformed talk-time JSON', () => {
  const db = openDb(':memory:');
  const good = meeting(db);
  const bad = meeting(db);
  db.saveSummary(good, {}, [{ displayName: 'Al', ms: 3000, words: 5 }, { ms: 1000 }], 'm');
  db.saveSummary(bad, {}, [], 'm');
  db.sql.prepare(`UPDATE summaries SET talktime_json = '{oops' WHERE meeting_id = ?`).run(bad);
  assert.equal(db.guildStats('g').totalTalkMs, 4000);
  assert.deepEqual(db.talkTimeLeaderboard('g'), [
    { displayName: 'Al', ms: 3000, words: 5, meetings: 1 },
    { displayName: 'Unknown', ms: 1000, words: 0, meetings: 1 },
  ]);
});

test('meetingsTimeline only counts the requested window', () => {
  const db = openDb(':memory:');
  meeting(db, { startedAt: new Date().toISOString() });
  meeting(db, { startedAt: '2001-01-01T00:00:00Z' });
  meeting(db, { startedAt: 'now' });
  const series = db.meetingsTimeline('g', 3);
  assert.equal(series.length, 3);
  assert.equal(series.reduce((sum, d) => sum + d.count, 0), 1);
});

test('searchUtterances tolerates NUL bytes and orders by meeting, then utterance', () => {
  const db = openDb(':memory:');
  const first = meeting(db, { utterances: 2, text: 'hello there' });
  const second = meeting(db, { utterances: 2, text: 'hello again' });
  assert.deepEqual(db.searchUtterances('g', 'a\u0000b'), []);
  const hits = db.searchUtterances('g', 'hello');
  assert.deepEqual(hits.map((h) => h.meeting_id), [second, second, first, first]);
  assert.ok(hits[0].id < hits[1].id);
});

test('openDb leaves a running journal update alone; the boot reconcile resets it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-journal-'));
  try {
    const path = join(dir, 'm.db');
    const db = openDb(path);
    const id = db.createCampaign({ guildId: 'g', name: 'C' });
    db.setJournalStatus(id, 'updating');
    const cli = openDb(path); // e.g. a script run beside the bot
    assert.equal(cli.getCampaign(id).journal_status, 'updating');
    await reconcileOnBoot(cli, join(dir, 'audio'), { log: quiet });
    assert.equal(db.getCampaign(id).journal_status, 'idle');
    db.sql.close();
    cli.sql.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsBundle matches the individual stats queries', () => {
  const db = openDb(':memory:');
  const id = meeting(db, { startedAt: new Date().toISOString() });
  db.saveSummary(id, {}, [{ displayName: 'Al', ms: 1500, words: 3 }], 'm');
  assert.deepEqual(db.statsBundle('g', 7), {
    stats: db.guildStats('g'),
    leaderboard: db.talkTimeLeaderboard('g'),
    timeline: db.meetingsTimeline('g', 7),
  });
  assert.equal(db.statsBundle('g').stats.totalTalkMs, 1500);
});

test('searchCampaignUtterances tolerates NUL bytes inside quoted terms', () => {
  const db = openDb(':memory:');
  const campaign = db.createCampaign({ guildId: 'g', name: 'C' });
  db.setMeetingCampaign(meeting(db, { text: 'the dragon sleeps' }), campaign);
  assert.deepEqual(db.searchCampaignUtterances(campaign, '"a\u0000b" OR "dragon"').map((u) => u.text), ['the dragon sleeps']);
});

test('replaceSummary can store per-stage timings in the same write', () => {
  const db = openDb(':memory:');
  const id = meeting(db);
  db.replaceSummary(id, 'g', { tldr: 'x' }, [], 'm', '2026-01-01T00:00:00Z', { transcribeMs: 5, summarizeMs: 7 });
  assert.deepEqual(db.getSummary(id).timings, { transcribeMs: 5, summarizeMs: 7 });
  db.replaceSummary(id, 'g', { tldr: 'y' }, [], 'm', '2026-01-01T00:00:00Z');
  assert.equal(db.getSummary(id).timings, null);
});

function renamedTranscript() {
  const db = openDb(':memory:');
  const id = Number(db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'Voice', startedAt: 'now' }));
  for (let i = 0; i < 5; i++) {
    db.addUtterance({ meetingId: id, userId: 'u1', displayName: 'Captured', startMs: i * 10, endMs: i * 10 + 5, text: `line ${i}` });
  }
  db.setSpeakerName('g', 'u1', 'Character');
  return { db, id };
}

test('listLastUtterances returns the last n rows in order with speaker renames', () => {
  const { db, id } = renamedTranscript();
  const rows = db.listLastUtterances(id, 2);
  assert.deepEqual(rows.map((u) => u.text), ['line 3', 'line 4']);
  assert.deepEqual(rows.map((u) => u.display_name), ['Character', 'Character']);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(db.listUtterances(id)[0]).sort());
});

test('utterancesBetween applies speaker renames', () => {
  const { db, id } = renamedTranscript();
  const rows = db.utterancesBetween(id, 10, 20);
  assert.deepEqual(rows.map((u) => [u.text, u.display_name]), [['line 1', 'Character'], ['line 2', 'Character']]);
});

test('hasUtterances answers whether a meeting has any transcript line, without loading them', () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 'now' });
  assert.equal(db.hasUtterances(id), false);
  db.addUtterance({ meetingId: id, userId: 'u', displayName: 'A', startMs: 0, endMs: 1, text: 'hi' });
  assert.equal(db.hasUtterances(id), true);
  assert.equal(db.hasUtterances(id + 1), false);
});
