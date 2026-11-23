export function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Stored transcripts are sentence-level (so lines can seek the recording).
// For prompts, back-to-back lines from one speaker are merged into a turn so
// the model isn't handed a timestamp and name on every sentence.
export const TURN_MERGE_GAP_MS = 2000;

function mergeTurns(sorted) {
  const turns = [];
  for (const u of sorted) {
    const last = turns[turns.length - 1];
    if (last && last.displayName === u.displayName && u.startMs - last.endMs <= TURN_MERGE_GAP_MS) {
      turns[turns.length - 1] = { ...last, endMs: Math.max(last.endMs, u.endMs), text: `${last.text} ${u.text}` };
    } else {
      turns.push({ ...u });
    }
  }
  return turns;
}

export function buildTranscript(utterances) {
  if (!utterances.length) return '';
  const sorted = [...utterances].sort((a, b) => a.startMs - b.startMs);
  const origin = sorted[0].startMs;
  return mergeTurns(sorted)
    .map((u) => `[${formatMs(u.startMs - origin)}] ${u.displayName}: ${u.text}`)
    .join('\n');
}

export function computeTalkTime(utterances) {
  const by = new Map();
  for (const u of utterances) {
    const cur = by.get(u.displayName) || { displayName: u.displayName, ms: 0, words: 0 };
    cur.ms += Math.max(0, u.endMs - u.startMs);
    cur.words += u.text.trim() ? u.text.trim().split(/\s+/).length : 0;
    by.set(u.displayName, cur);
  }
  const stats = [...by.values()];
  const totalMs = stats.reduce((s, x) => s + x.ms, 0) || 1;
  for (const s of stats) s.pct = Math.round((s.ms / totalMs) * 100);
  return stats.sort((a, b) => b.ms - a.ms);
}
