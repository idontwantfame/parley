import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Avatar, Icon } from '../ui.jsx';
import { fmtClock, colorOf } from '../../lib/format.js';

// Lines rendered per step. A multi-hour meeting has thousands of lines; render
// them a page at a time instead of all at once.
const TRANSCRIPT_PAGE = 300;

// Index of the line playing at `atMs`: the last one starting at or before it.
function lineAt(lines, atMs) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start_ms <= atMs) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

// Keeps the in-page player and the transcript in step: clicking a line seeks
// the recording to it, and the line being played is highlighted.
function useRecordingSync(lines, originMs) {
  const audioRef = useRef(null);
  const [activeId, setActiveId] = useState(null);
  const onTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || originMs == null) return;
    const idx = lineAt(lines, originMs + audio.currentTime * 1000);
    const id = idx >= 0 ? lines[idx].id : null;
    setActiveId((cur) => (cur === id ? cur : id));
  }, [lines, originMs]);
  const seek = useCallback((u) => {
    const audio = audioRef.current;
    if (!audio || originMs == null) return;
    audio.currentTime = Math.max(0, (u.start_ms - originMs) / 1000);
    audio.play().catch(() => { /* autoplay refused: the position is still set */ });
  }, [originMs]);
  return { audioRef, activeId, onTime, seek };
}

function RecordingPlayer({ meetingId, audioRef, onTime }) {
  return (
    <section className="mt-9 card p-4 sticky top-3 z-10" aria-label="Recording">
      <audio ref={audioRef} controls preload="metadata" className="w-full"
        src={api.meetingAudioUrl(meetingId, { inline: true })} onTimeUpdate={onTime} onSeeked={onTime} />
      <p className="text-xs text-muted mt-1.5">Click a line in the transcript to play from there.</p>
    </section>
  );
}

const TranscriptLine = memo(function TranscriptLine({ u, label, active, onSeek }) {
  // The whole line seeks, unless the click was the end of a text selection.
  const seekFromRow = onSeek ? () => { if (window.getSelection()?.isCollapsed !== false) onSeek(u); } : undefined;
  return (
    <div className={`flex items-start gap-3 rounded-sm -mx-2 px-2 py-1 transition-colors ${active ? 'bg-primary-soft' : ''} ${onSeek ? 'cursor-pointer hover:bg-surface-2' : ''}`}
      onClick={seekFromRow} aria-current={active ? 'true' : undefined}>
      <Avatar name={u.display_name} size={28} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold" style={{ color: colorOf(u.display_name) }}>{u.display_name}</span>
          {onSeek ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); onSeek(u); }}
              className="text-[11px] text-primary tabular-nums hover:underline" aria-label={`Play from ${label}`}>{label}</button>
          ) : <span className="text-[11px] text-faint tabular-nums">{label}</span>}
        </div>
        <p className="text-[14px] text-ink-2 leading-relaxed mt-0.5">{u.text}</p>
      </div>
    </div>
  );
});

// How many of `filtered` to render: a page at a time, reset by a new search,
// and always far enough to include the line being played (playback or the
// player's scrubber can move past what's on screen).
function useRenderLimit(filtered, query, activeId) {
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE);
  const [limitQuery, setLimitQuery] = useState(query);
  const indexById = useMemo(() => new Map(filtered.map((u, i) => [u.id, i])), [filtered]);
  let current = limit;
  if (limitQuery !== query) {
    setLimitQuery(query);
    current = TRANSCRIPT_PAGE;
    setLimit(current);
  }
  const activeIdx = activeId == null ? -1 : (indexById.get(activeId) ?? -1);
  const needed = Math.ceil((activeIdx + 1) / TRANSCRIPT_PAGE) * TRANSCRIPT_PAGE;
  if (needed > current) setLimit(needed);
  const showMore = useCallback(() => setLimit((n) => n + TRANSCRIPT_PAGE), []);
  const showAll = useCallback(() => setLimit(Infinity), []);
  return { limit: Math.max(current, needed), showMore, showAll };
}

// `lines` are sorted by start; times are shown from `baseMs` (the recording's
// start when there is one, else the first line), not as raw epoch values.
function Transcript({ lines, baseMs, activeId = null, onSeek = null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Filtering a multi-hour transcript on every keystroke is expensive; let the
  // input stay responsive and filter against the deferred query.
  const deferredQ = useDeferredValue(q);
  const filtered = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase();
    return needle ? lines.filter((u) => u.text.toLowerCase().includes(needle)) : lines;
  }, [lines, deferredQ]);
  const { limit, showMore, showAll } = useRenderLimit(filtered, deferredQ, activeId);
  if (!lines.length) return null;

  const shown = filtered.length > limit ? filtered.slice(0, limit) : filtered;
  const remaining = filtered.length - shown.length;
  return (
    <section className="mt-10 pt-8 border-t border-border">
      <div className="flex items-center justify-between gap-3 mb-4">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-bold text-ink" aria-expanded={open}>
          <Icon.Chevron width={16} height={16} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          Transcript
          <span className="chip">{lines.length} lines</span>
        </button>
        {open && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in transcript…"
            aria-label="Find in transcript" className="input !w-52 !py-1.5 text-[13px]" />
        )}
      </div>
      {open && (
        <div className="space-y-2">
          {filtered.length === 0 && <p className="text-sm text-muted">No lines match "{q}".</p>}
          {shown.map((u, i) => (
            <TranscriptLine key={u.id ?? i} u={u} label={fmtClock(u.start_ms - baseMs)}
              active={u.id === activeId} onSeek={onSeek} />
          ))}
          {remaining > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="text-xs text-muted">{remaining} more line{remaining === 1 ? '' : 's'}</span>
              <button type="button" onClick={showMore} className="btn btn-ghost !py-1.5">
                Show {Math.min(TRANSCRIPT_PAGE, remaining)} more
              </button>
              <button type="button" onClick={showAll} className="btn btn-ghost !py-1.5">Show all</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The recording player (when the audio can be played in step with the lines)
 * and the transcript. The playing line lives here, not in the note, so a new
 * line re-renders only this part of the page.
 */
export default function RecordingTranscript({ meetingId, lines, originMs = null }) {
  const playable = originMs != null;
  const { audioRef, activeId, onTime, seek } = useRecordingSync(lines, originMs);
  return (
    <>
      {playable && <RecordingPlayer meetingId={meetingId} audioRef={audioRef} onTime={onTime} />}
      <Transcript lines={lines} baseMs={playable ? originMs : (lines[0]?.start_ms ?? 0)}
        activeId={playable ? activeId : null} onSeek={playable ? seek : null} />
    </>
  );
}
