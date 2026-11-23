import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useIsAdmin } from '../../AuthContext.jsx';
import { Icon } from '../ui.jsx';
import { fmtDateLong, fmtTime } from '../../lib/format.js';
import { useDismissable } from '../../hooks/useDismissable.js';
import { useSingleFlight } from '../../hooks/useSingleFlight.js';

const MERGED_SUMMARY_FAILED = 'The meetings were merged, but the new summary failed — use Regenerate summary.';

// Merge candidates: other meetings from this meeting's own server (never the
// server-switcher's selection), loaded only when the merge picker opens and
// again whenever `version` changes (after a failed merge).
function useMergeCandidates(meeting, active, version) {
  const [state, setState] = useState({ rows: null, error: null });
  useEffect(() => {
    if (!active) return undefined;
    let stale = false;
    setState({ rows: null, error: null });
    api.meetings(meeting.guild_id)
      .then((rows) => {
        if (stale) return;
        const list = (Array.isArray(rows) ? rows : [])
          .filter((m) => m.id !== meeting.id && ((m.utterance_count ?? 1) > 0 || m.failed));
        setState({ rows: list, error: null });
      })
      .catch((e) => { if (!stale) setState({ rows: [], error: e?.message || 'Could not load meetings.' }); });
    return () => { stale = true; };
  }, [meeting.id, meeting.guild_id, active, version]);
  return state;
}

function MenuItem({ onClick, disabled, danger = false, title, icon: IconC, children }) {
  const tone = danger ? 'text-error hover:bg-error-soft' : 'text-ink hover:bg-surface-2';
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} title={title}
      className={`w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm ${tone} disabled:opacity-40`}>
      <IconC width={15} height={15} /> {children}
    </button>
  );
}

function MergePicker({ candidates, sources, busy, err, onToggle, onCancel, onMerge }) {
  const others = candidates.rows ?? [];
  return (
    <div className="absolute right-0 mt-1.5 w-80 card shadow-lg p-3 z-20">
      <p className="text-sm font-semibold text-ink mb-2">Merge into this note</p>
      <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-0.5">
        {candidates.rows === null && <p className="text-xs text-muted px-2 py-1.5">Loading meetings…</p>}
        {candidates.error && <p className="text-xs text-error px-2 py-1.5">{candidates.error}</p>}
        {candidates.rows?.length === 0 && !candidates.error && <p className="text-xs text-muted px-2 py-1.5">No other meetings to merge.</p>}
        {others.map((m) => (
          <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-2 cursor-pointer text-sm">
            <input type="checkbox" className="pcheck h-4 w-4" checked={sources.has(m.id)} onChange={() => onToggle(m.id)} disabled={busy} />
            <span className="text-ink truncate">{fmtDateLong(m.started_at)}</span>
            <span className="text-muted text-xs ml-auto shrink-0">{fmtTime(m.started_at)}</span>
          </label>
        ))}
      </div>
      {err && <p className="text-xs text-error mt-2" role="alert">{err}</p>}
      <div className="flex items-center justify-end gap-2 mt-3">
        <button onClick={onCancel} disabled={busy} className="btn btn-ghost !py-1.5">Cancel</button>
        <button onClick={onMerge} disabled={sources.size === 0 || busy} className="btn btn-primary !py-1.5">
          {busy ? 'Merging…' : `Merge ${sources.size || ''}`.trim()}
        </button>
      </div>
    </div>
  );
}

/* ── meeting actions (export / regenerate / merge / delete) ────────────── */
export default function MeetingActions({ meeting, regenerate, regenerating, onRegenerate, hasAudio, onReload }) {
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(false); // false | 'pick' | 'busy'
  const [sources, setSources] = useState(() => new Set());
  const [err, setErr] = useState(null);
  const [candidatesVersion, setCandidatesVersion] = useState(0);
  const candidates = useMergeCandidates(meeting, !!mode, candidatesVersion);
  // Deletes run one at a time: a second click can't fire a second request.
  const [deleting, runDelete] = useSingleFlight();
  // Close the menu/merge popover on outside click or Escape (a11y).
  const ref = useDismissable(open || !!mode, () => { setOpen(false); if (mode !== 'busy') setMode(false); });

  function deleteMeeting() {
    setOpen(false);
    return runDelete(async () => {
      if (!window.confirm('Delete this meeting, its transcript, summary and action items? This cannot be undone.')) return;
      try { await api.deleteMeeting(meeting.id); navigate('/meetings'); }
      catch (e) { setErr(e?.message || 'Delete failed'); }
    });
  }
  function deleteRecording() {
    setOpen(false);
    return runDelete(async () => {
      if (!window.confirm('Delete this recording? The transcript and notes will stay.')) return;
      try { await api.deleteMeetingAudio(meeting.id); onReload?.(); }
      catch (e) { setErr(e?.message || 'Could not delete the recording.'); }
    });
  }
  function toggle(id) { setSources((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  async function merge() {
    if (sources.size === 0 || mode === 'busy') return;
    setMode('busy'); setErr(null);
    try {
      await api.mergeMeetings(meeting.id, [...sources]);
      setMode(false); setSources(new Set()); onReload?.();
    } catch (e) {
      // Whatever failed, the note and the candidate list may be stale now (a
      // 502 means the merge itself went through): start over from fresh data.
      setSources(new Set());
      onReload?.();
      if (e?.status === 502) {
        setMode(false);
        setErr(MERGED_SUMMARY_FAILED);
      } else {
        setMode('pick');
        setCandidatesVersion((v) => v + 1);
        setErr(e?.message || 'Merge failed');
      }
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={() => { setOpen((v) => !v); setMode(false); setErr(null); }} aria-label="Meeting actions"
        aria-haspopup="menu" aria-expanded={open || !!mode}
        className="h-9 w-9 grid place-items-center rounded-sm border border-border text-muted hover:text-ink hover:bg-surface-2 transition-colors">
        <Icon.Dots width={18} height={18} />
      </button>
      {open && !mode && (
        <div role="menu" className="absolute right-0 mt-1.5 w-52 card shadow-lg py-1 z-20">
          <a href={api.exportMeetingUrl(meeting.id, 'md')} role="menuitem" onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-ink hover:bg-surface-2 no-underline">
            <Icon.Download width={15} height={15} /> Export (markdown)
          </a>
          {hasAudio && (
            <a href={api.meetingAudioUrl(meeting.id)} role="menuitem" onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-ink hover:bg-surface-2 no-underline">
              <Icon.Download width={15} height={15} /> Download recording
            </a>
          )}
          {hasAudio && isAdmin && (
            <MenuItem onClick={deleteRecording} disabled={deleting} danger icon={Icon.Trash}>Delete recording</MenuItem>
          )}
          {isAdmin && (
            <>
              <MenuItem onClick={() => { setOpen(false); onRegenerate?.(); }} icon={Icon.Refresh}
                disabled={!regenerate?.eligible || regenerating}
                title={!regenerate?.eligible && regenerate?.reason ? regenerate.reason : 'Re-run the summary with the current summarizer settings'}>
                Regenerate summary
              </MenuItem>
              <MenuItem onClick={() => { setErr(null); setMode('pick'); setOpen(false); }} icon={Icon.Merge}>
                Merge another meeting
              </MenuItem>
              <MenuItem onClick={deleteMeeting} disabled={deleting} danger icon={Icon.Trash}>Delete meeting</MenuItem>
            </>
          )}
        </div>
      )}
      {mode && (
        <MergePicker candidates={candidates} sources={sources} busy={mode === 'busy'} err={err}
          onToggle={toggle} onMerge={merge}
          onCancel={() => { setMode(false); setSources(new Set()); setErr(null); }} />
      )}
      {err && !mode && <p className="text-xs text-error mt-1 absolute right-0 w-72 text-right z-10" role="alert">{err}</p>}
    </div>
  );
}
