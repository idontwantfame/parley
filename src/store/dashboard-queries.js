// src/store/dashboard-queries.js
// Read-only dashboard queries over the meetings db: the enriched meeting list,
// list neighbours, campaign-less meetings and the stats page aggregates.
// Mixed into the object returned by openDb (src/store/db.js).

// Rows a meeting list shows: transcribed, or failed/stuck so a retry is offered.
const LISTED_MEETING = `(EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id)
  OR m.status IN ('transcription_failed', 'summary_failed', 'processing'))`;

function parseNotes(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

export function dashboardQueries(sql) {
  // Per-person talk-time and the overall total from one pass over the stored
  // talktime JSON (measured faster than SQLite json_each for these small
  // arrays). Malformed rows are skipped.
  function talkTime(guildId) {
    const rows = sql.prepare(
      `SELECT s.talktime_json FROM summaries s JOIN meetings m ON m.id = s.meeting_id WHERE m.guild_id = ?`
    ).all(guildId);
    const by = new Map(); // name -> { displayName, ms, words, meetings }
    let totalMs = 0;
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.talktime_json); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const p of parsed) {
        const name = p?.displayName || 'Unknown';
        const cur = by.get(name) || { displayName: name, ms: 0, words: 0, meetings: 0 };
        by.set(name, { ...cur, ms: cur.ms + (p?.ms || 0), words: cur.words + (p?.words || 0), meetings: cur.meetings + 1 });
        totalMs += p?.ms || 0;
      }
    }
    return { totalMs, leaderboard: [...by.values()].sort((a, b) => b.ms - a.ms) };
  }

  const queries = {
    // Meetings enriched with per-row counts + a short summary preview, in one
    // pass. Used by the meetings overview + dashboard cards so the client never
    // needs N detail fetches just to render a list.
    // `before` (a meeting id) pages backwards: only meetings with a lower id.
    listRecentRich(guildId, limit = 50, { before = null } = {}) {
      const rows = sql.prepare(
        `SELECT m.*,
            (SELECT COUNT(*) FROM utterances u WHERE u.meeting_id = m.id) AS utterance_count,
            (SELECT COUNT(*) FROM attendees a WHERE a.meeting_id = m.id) AS attendee_count,
            (SELECT COUNT(*) FROM todos t WHERE t.meeting_id = m.id) AS action_count,
            (SELECT COUNT(*) FROM todos t WHERE t.meeting_id = m.id AND t.done = 0) AS open_action_count,
            s.notes_json, s.talktime_json
         FROM meetings m
         LEFT JOIN summaries s ON s.meeting_id = m.id
         WHERE m.guild_id = ? AND (? IS NULL OR m.id < ?) ORDER BY m.id DESC LIMIT ?`
      ).all(guildId, before, before, limit);
      return rows.map(({ notes_json, talktime_json, ...m }) => {
        let tldr = null, topic_count = 0, decision_count = 0;
        let talktime = [];
        try { if (notes_json) {
          const n = JSON.parse(notes_json);
          tldr = n.tldr ?? null;
          topic_count = Array.isArray(n.topics) ? n.topics.length : 0;
          decision_count = Array.isArray(n.decisions) ? n.decisions.length : 0;
        } } catch { /* keep defaults */ }
        try { if (talktime_json) talktime = JSON.parse(talktime_json) || []; } catch { /* [] */ }
        const attendee_names = sql.prepare(
          `SELECT display_name FROM attendees WHERE meeting_id = ? ORDER BY display_name`
        ).all(m.id).map((a) => a.display_name);
        return { ...m, tldr, topic_count, decision_count, talktime, attendee_names,
          has_summary: notes_json != null,
          // Failed/stuck meetings the dashboard can offer a retry for. The
          // detail endpoint refines this with a precise plan (audio on disk?).
          failed: ['transcription_failed', 'summary_failed', 'processing'].includes(m.status) };
      });
    },

    // The adjacent meetings (by id, same guild) that the meetings list shows.
    meetingNeighbors(meeting) {
      const pick = (op, order) => {
        const row = sql.prepare(
          `SELECT m.id, m.started_at FROM meetings m
            WHERE m.guild_id = ? AND m.id ${op} ? AND ${LISTED_MEETING}
            ORDER BY m.id ${order} LIMIT 1`
        ).get(meeting.guild_id, meeting.id);
        return row ? { id: row.id, started_at: row.started_at } : null;
      };
      return { older: pick('<', 'DESC'), newer: pick('>', 'ASC') };
    },

    // The guild's most recent meetings outside any campaign ("Add sessions").
    listUnassignedMeetings(guildId, limit = 200) {
      return sql.prepare(
        `SELECT m.id, m.channel_name, m.started_at, m.status, s.notes_json
           FROM meetings m LEFT JOIN summaries s ON s.meeting_id = m.id
          WHERE m.guild_id = ? AND m.campaign_id IS NULL AND m.status != 'empty'
          ORDER BY m.id DESC LIMIT ?`
      ).all(guildId, limit).map(({ notes_json, ...m }) => ({ ...m, tldr: parseNotes(notes_json)?.tldr ?? null }));
    },

    // Headline numbers for a guild's dashboard. Pass `totalTalkMs` when the
    // talk-time totals were already computed (see statsBundle).
    guildStats(guildId, { totalTalkMs = talkTime(guildId).totalMs } = {}) {
      const base = sql.prepare(
        `SELECT
           COUNT(*) AS total_meetings,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_meetings,
           MIN(started_at) AS first_meeting,
           MAX(started_at) AS last_meeting
         FROM meetings WHERE guild_id = ?`
      ).get(guildId) || {};
      const utt = sql.prepare(
        `SELECT COUNT(*) AS c FROM utterances u JOIN meetings m ON m.id = u.meeting_id WHERE m.guild_id = ?`
      ).get(guildId) || { c: 0 };
      const todoCounts = sql.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
         FROM todos WHERE guild_id = ?`
      ).get(guildId) || {};
      const people = sql.prepare(
        `SELECT COUNT(DISTINCT user_id) AS c FROM attendees a JOIN meetings m ON m.id = a.meeting_id WHERE m.guild_id = ?`
      ).get(guildId) || { c: 0 };
      return {
        totalMeetings: base.total_meetings || 0,
        doneMeetings: base.done_meetings || 0,
        firstMeeting: base.first_meeting || null,
        lastMeeting: base.last_meeting || null,
        totalUtterances: utt.c || 0,
        totalTalkMs,
        people: people.c || 0,
        todos: { total: todoCounts.total || 0, open: todoCounts.open || 0, done: todoCounts.done || 0 },
      };
    },

    // Per-person talk-time + meeting count across the guild, descending by ms.
    talkTimeLeaderboard(guildId) {
      return talkTime(guildId).leaderboard;
    },

    // Everything the stats page shows, parsing the talk-time JSON only once.
    statsBundle(guildId, days = 30) {
      const { totalMs, leaderboard } = talkTime(guildId);
      return {
        stats: queries.guildStats(guildId, { totalTalkMs: totalMs }),
        leaderboard,
        timeline: queries.meetingsTimeline(guildId, days),
      };
    },

    // Meetings-per-local-day for the timeline chart (last `days` days inclusive).
    // Only rows inside the window (plus a day of timezone slack) are loaded;
    // non-ISO values still reach the parser below, which skips them.
    meetingsTimeline(guildId, days = 30) {
      const since = new Date(Date.now() - (days + 1) * 86_400_000).toISOString().slice(0, 10);
      const rows = sql.prepare(
        `SELECT started_at FROM meetings WHERE guild_id = ? AND started_at IS NOT NULL AND started_at >= ?`
      ).all(guildId, since);
      const counts = new Map();
      for (const { started_at } of rows) {
        const d = new Date(String(started_at).replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        out.push({ date: key, count: counts.get(key) || 0 });
      }
      return out;
    },
  };
  return queries;
}
