import { getSummarizer } from './index.js';
import { extractTerms } from '../../pipeline/search-terms.js';

// Characters of transcript one /ask prompt may carry. Ollama runs with an 8192
// token context (and silently drops the start of a longer prompt — the
// instructions); cloud models are bigger but not unlimited.
const ASK_TRANSCRIPT_CHARS = { ollama: 6_000, gemini: 600_000 };
const DEFAULT_ASK_TRANSCRIPT_CHARS = 120_000;
const CONTEXT_OFFSETS = [0, -1, 1, -2, 2, -3, 3]; // a match, then its neighbours
const GAP = '[…]';

/** Transcript budget for a guild's summarizer, and its fallback if one is set. */
export function askTranscriptBudget(cfg = {}) {
  const budget = (provider) => ASK_TRANSCRIPT_CHARS[provider] ?? DEFAULT_ASK_TRANSCRIPT_CHARS;
  const fallback = cfg.summarizerFallbackProvider ? budget(cfg.summarizerFallbackProvider) : Infinity;
  return Math.min(budget(cfg.summarizerProvider), fallback);
}

// Lines matching the most question terms first, each with a little of the
// surrounding conversation, until the budget is spent.
function relevantLines(lines, terms, budget) {
  const keep = new Set();
  if (!terms.length) return keep;
  const score = (line) => terms.filter((t) => line.toLowerCase().includes(t)).length;
  const hits = lines.map((line, i) => ({ i, score: score(line) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  let used = 0;
  for (const { i } of hits) {
    for (const j of CONTEXT_OFFSETS.map((d) => i + d).filter((j) => j >= 0 && j < lines.length && !keep.has(j))) {
      const cost = lines[j].length + GAP.length + 2;
      if (used + cost > budget) return keep;
      keep.add(j);
      used += cost;
    }
  }
  return keep;
}

// The opening and closing lines, half the budget each.
function headAndTail(lines, budget) {
  const keep = new Set();
  const take = (indexes) => {
    let used = 0;
    for (const i of indexes) {
      if (used + lines[i].length + 1 > budget / 2) return;
      keep.add(i);
      used += lines[i].length + 1;
    }
  };
  take(lines.keys());
  take([...lines.keys()].reverse());
  return keep;
}

function joinWithGaps(lines, keep) {
  const out = [];
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > previous + 1) out.push(GAP);
    out.push(lines[i]);
    previous = i;
  }
  if (previous < lines.length - 1) out.push(GAP);
  return out.join('\n');
}

// The transcript, or excerpts of it that fit `maxChars`.
function fitTranscript(transcript, question, maxChars) {
  if (transcript.length <= maxChars) return { text: transcript, excerpted: false };
  const lines = transcript.split('\n');
  const relevant = relevantLines(lines, extractTerms(question), maxChars);
  const keep = relevant.size ? relevant : headAndTail(lines, maxChars);
  return { text: joinWithGaps(lines, keep), excerpted: true };
}

export function buildAskPrompt(question, transcript, meta = {}, { maxChars = DEFAULT_ASK_TRANSCRIPT_CHARS } = {}) {
  const { text, excerpted } = fitTranscript(String(transcript ?? ''), question, maxChars);
  const note = excerpted
    ? `\nThe meeting is long, so only excerpts of the transcript are shown (most relevant to the question; ${GAP} marks skipped parts).`
    : '';
  return `Answer the question using ONLY the meeting transcript below. If the transcript does not contain the answer, say so plainly. Be concise.${note}

Meeting: ${meta.channelName || ''} ${meta.date ? `on ${meta.date}` : ''}
Attendees: ${(meta.attendees || []).join(', ')}

Transcript:
${text}

Question: ${question}`;
}

export async function askMeeting({ cfg, env, question, transcript, meta }) {
  const s = getSummarizer(cfg, env);
  if (typeof s.ask !== 'function') throw new Error(`Provider ${cfg.summarizerProvider} does not support Q&A`);
  return s.ask(buildAskPrompt(question, transcript, meta, { maxChars: askTranscriptBudget(cfg) }));
}
