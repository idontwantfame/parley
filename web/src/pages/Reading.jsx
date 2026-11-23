import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useIsAdmin } from '../AuthContext.jsx';
import { ProgressText } from '../components/Live.jsx';
import { Avatar, AvatarStack, Icon, Empty, TalkBar } from '../components/ui.jsx';
import { fmtDateLong, fmtTime, fmtDuration, fmtMs, colorOf } from '../lib/format.js';
import Markdown from '../components/LazyMarkdown.jsx';
import MeetingActions from '../components/meeting/MeetingActions.jsx';
import RecordingTranscript from '../components/meeting/RecordingTranscript.jsx';

// Meeting ids are numeric; anything else in the URL is not a meeting (and
// must never reach a request path).
const MEETING_ID = /^\d+$/;

/* ── retry banner (failed / stuck meetings) ───────────────────────────── */
const STATUS_COPY = {
  transcription_failed: {
    title: 'Transcription failed',
    body: 'The speech-to-text sidecar was unreachable or errored while transcribing this meeting. If the audio is still on disk, you can retry the whole pipeline.',
  },
  summary_failed: {
    title: 'Summary failed',
    body: 'The transcript was captured, but the summarizer errored (often a transient rate-limit or a missing API key). Retrying re-runs only the summary.',
  },
  processing: {
    title: 'Stuck processing',
    body: 'This meeting was left mid-process, likely because the bot restarted. Retry to finish it.',
  },
};

function RetryBanner({ meeting, retry, outcome, onStarted }) {
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const copy = STATUS_COPY[meeting.status] || { title: 'Needs attention', body: `Status: ${meeting.status}.` };
  const canRetry = retry?.eligible && isAdmin;

  // The server answers 202 as soon as the retry is queued; progress is then
  // followed by the note's poller rather than one long blocking request.
  async function run() {
    setBusy(true); setErr(null);
    try {
      await api.retryMeeting(meeting.id);
      onStarted?.();
    } catch (e) {
      setErr(e?.message || 'Retry failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 mt-8 border-l-2" style={{ borderColor: 'var(--error)' }}>
      <div className="flex items-start gap-3">
        <Icon.Alert width={20} height={20} className="text-error shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">{copy.title}</p>
          <p className="text-[13.5px] text-muted leading-relaxed mt-1">{copy.body}</p>
          {meeting.import_error && <p className="text-[13px] text-error mt-2">{meeting.import_error}</p>}
          {!retry?.eligible && retry?.reason && <p className="text-[13px] text-error mt-2">{retry.reason}</p>}
          {retry?.eligible && !isAdmin && <p className="text-[13px] text-muted mt-2">Ask an admin to retry this meeting.</p>}
          {outcome && <p className="text-[13px] text-error mt-2" role="alert">{outcome}</p>}
          {err && <p className="text-[13px] text-error mt-2" role="alert">{err}</p>}
          {isAdmin && <div className="mt-3.5 flex items-center gap-2">
            <button onClick={run} disabled={!canRetry || busy} className="btn btn-primary !py-2">
              {busy ? (
                <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />Retrying…</span>
              ) : (
                <span className="inline-flex items-center gap-2"><Icon.Refresh width={15} height={15} />Retry {retry?.action === 'retranscribe' ? 'transcription' : 'summary'}</span>
              )}
            </button>
          </div>}
        </div>
      </div>
    </div>
  );
}

/* ── action item (in-note, checkable) ─────────────────────────────────── */
function ActionItem({ item, todo, onToggle }) {
  const isAdmin = useIsAdmin();
  const [done, setDone] = useState(Boolean(todo?.done));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (todo) setDone(Boolean(todo.done)); }, [todo]);

  async function change() {
    if (!todo || busy) return;
    const next = !done;
    setDone(next); setBusy(true); setErr(null);
    try { await api.setTodoDone(todo.id, next); onToggle?.(); }
    catch (e) {
      setDone(!next);
      setErr(e?.status === 403 ? 'Only admins can edit action items.' : (e?.message || 'Could not update this item.'));
    }
    finally { setBusy(false); }
  }

  return (
    <li className="flex items-start gap-3 group">
      <input type="checkbox" checked={done} onChange={change} disabled={!todo || busy || !isAdmin}
        title={isAdmin ? undefined : 'Only admins can edit action items.'} className="pcheck mt-0.5" aria-label={item.task} />
      <div className="min-w-0">
        <span className={`text-[14.5px] leading-relaxed ${done ? 'line-through text-muted' : 'text-ink'}`}>{item.task}</span>
        {err && <span className="block text-xs text-error mt-0.5" role="alert">{err}</span>}
        {item.assignee && (
          <span className="ml-2 inline-flex items-center gap-1.5 align-middle chip">
            <Avatar name={item.assignee} size={16} />{item.assignee}
          </span>
        )}
      </div>
    </li>
  );
}

/* ── ask box ──────────────────────────────────────────────────────────── */
function AskBox({ guildId, meetingId }) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  const SUGGESTIONS = ['What was decided?', 'Who owns what?', 'Summarize in 3 bullets'];

  async function ask(qStr) {
    const q = (qStr ?? question).trim();
    if (!q || loading) return;
    setQuestion(q); setLoading(true); setAnswer(null); setError(null);
    try { const res = await api.ask(guildId, meetingId, q); setAnswer(res.answer); }
    catch (err) { setError(err?.message || 'Request failed'); }
    finally { setLoading(false); }
  }

  return (
    <section className="mt-10 card p-5"
      style={{ background: 'linear-gradient(180deg, var(--primary-soft), transparent)' }}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-3">
        <Icon.Sparkle width={16} height={16} className="text-primary" /> Ask this meeting
      </h2>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask anything about this meeting…"
          disabled={loading} className="input flex-1" />
        <button type="submit" disabled={!question.trim() || loading} className="btn btn-primary">
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {!answer && !loading && (
        <div className="flex flex-wrap gap-2 mt-3">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} className="chip hover:!bg-surface-2 transition-colors">{s}</button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-error" role="alert">{error}</p>}
      {answer && (
        <div className="mt-4 text-[14.5px] text-ink leading-relaxed bg-surface-2 rounded-sm p-4 border border-border animate-fade-in">
          <Markdown text={answer} />
        </div>
      )}
    </section>
  );
}

/* ── prev/next meeting nav ────────────────────────────────────────────── */
function MeetingNav({ neighbors }) {
  const older = neighbors?.older;
  const newer = neighbors?.newer;
  if (!older && !newer) return null;
  return (
    <div className="flex items-center justify-between gap-3 mt-12 pt-6 border-t border-border">
      {older ? (
        <Link to={`/meetings/${older.id}`} className="group flex items-center gap-2 text-sm text-muted hover:text-ink no-underline">
          <Icon.Arrow width={16} height={16} className="rotate-180" />
          <span><span className="block text-[11px] text-faint">Older</span>{fmtDateLong(older.started_at)}</span>
        </Link>
      ) : <span />}
      {newer ? (
        <Link to={`/meetings/${newer.id}`} className="group flex items-center gap-2 text-sm text-muted hover:text-ink no-underline text-right">
          <span><span className="block text-[11px] text-faint">Newer</span>{fmtDateLong(newer.started_at)}</span>
          <Icon.Arrow width={16} height={16} />
        </Link>
      ) : <span />}
    </div>
  );
}

/* ── speakers of an imported recording ──────────────────────────────── */
// Imported recordings label voices "Speaker 1", "Speaker 2"…; naming them here
// applies to this recording only. Regenerating the summary puts the names
// into the notes too.
// `saved` lives in the note: the panel is re-created from the server's names
// after a save, and the regenerate offer must survive that.
function SpeakerNamesPanel({ meeting, attendees, saved, onSaved, canRegenerate, onRegenerate, onReload }) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(attendees.map((a) => [a.user_id, a.display_name])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const changed = attendees.filter((a) => (drafts[a.user_id] ?? '').trim() !== a.display_name);
      for (const a of changed) await api.setSpeakerName(meeting.guild_id, a.user_id, (drafts[a.user_id] ?? '').trim());
      if (changed.length) { onSaved(); onReload?.(); }
    } catch (e) {
      setErr(e?.message || 'Could not save the names.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 card p-5" aria-label="Speakers">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-1"><Icon.Users width={16} height={16} />Speakers</h2>
      <p className="text-xs text-muted mb-4">Detected automatically. Name them to make the transcript readable; clear a name to go back to the label.</p>
      <form onSubmit={save} className="space-y-2.5">
        {attendees.map((a, i) => (
          <label key={a.user_id} className="flex items-center gap-3">
            <Avatar name={a.display_name} size={24} />
            <span className="text-xs text-muted w-20 shrink-0">Voice {i + 1}</span>
            <input className="input flex-1 !py-1.5" value={drafts[a.user_id] ?? ''} disabled={busy}
              onChange={(e) => setDrafts((d) => ({ ...d, [a.user_id]: e.target.value }))} aria-label={`Name for voice ${i + 1}`} />
          </label>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <button type="submit" className="btn btn-primary !py-1.5" disabled={busy}>{busy ? 'Saving…' : 'Save names'}</button>
          {saved && canRegenerate && (
            <button type="button" className="btn btn-ghost !py-1.5" onClick={onRegenerate}>
              <Icon.Refresh width={14} height={14} />Regenerate notes with these names
            </button>
          )}
        </div>
        {err && <p className="text-xs text-error" role="alert">{err}</p>}
      </form>
    </section>
  );
}

/* ── note document ────────────────────────────────────────────────────── */
const PROGRESS_POLL_MS = 2500;
// Polls with no progress and an unchanged status before giving up (~20 s): a
// meeting left "processing" by a crash would otherwise be polled forever.
const IDLE_POLL_LIMIT = 8;

// Follows server-side processing (transcription, summary, a retry) for one
// meeting. Pauses while the tab is hidden and stops once nothing is running.
function useMeetingProgress(meeting, initial, onReload) {
  const [progress, setProgress] = useState(initial);
  const [watching, setWatching] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const watchingRef = useRef(false);
  useEffect(() => { setProgress(initial); }, [initial]);

  const active = Boolean(progress) || watching || meeting.status === 'processing';
  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    let timer;
    let idle = 0;
    let sawProgress = false;
    function finish(message) {
      if (watchingRef.current && message) setOutcome(message);
      watchingRef.current = false;
      setWatching(false);
      onReload?.();
    }
    async function poll() {
      if (stop) return;
      if (document.hidden) { timer = setTimeout(poll, PROGRESS_POLL_MS); return; }
      try {
        const current = await api.meetingProgress(meeting.id);
        if (stop) return;
        setProgress(current.progress);
        if (current.progress) { sawProgress = true; idle = 0; }
        else if (current.status !== meeting.status) return finish(null);
        else if (sawProgress || ++idle >= IDLE_POLL_LIMIT) {
          return finish('The retry ended without fixing this meeting. Check the server log for details.');
        }
      } catch { /* Retry after a temporary connection failure. */ }
      if (!stop) timer = setTimeout(poll, PROGRESS_POLL_MS);
    }
    void poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [active, meeting.id, meeting.status, onReload]);

  const watchRetry = useCallback(() => {
    watchingRef.current = true;
    setOutcome(null);
    setWatching(true);
  }, []);
  return { progress, watching, outcome, watchRetry };
}

const REGEN_POLL_MS = 2000;
const DISMISSED_PREFIX = 'parley-regen-dismissed:';

// A dismissed regeneration error stays dismissed for this meeting for the rest
// of the browser session (the server keeps reporting it for a while).
function readDismissed(meetingId) {
  try { return sessionStorage.getItem(DISMISSED_PREFIX + meetingId); } catch { return null; }
}
function writeDismissed(meetingId, error) {
  try {
    if (error) sessionStorage.setItem(DISMISSED_PREFIX + meetingId, error);
    else sessionStorage.removeItem(DISMISSED_PREFIX + meetingId);
  } catch { /* storage unavailable: the error just shows again next visit */ }
}

// Summary regeneration for one meeting: start it, follow it (paused while the
// tab is hidden), and report or dismiss its failure.
function useRegeneration(meeting, initial, onReload) {
  const [regen, setRegen] = useState(() => {
    const err = initial?.error ?? null;
    return { busy: initial?.state === 'running', progress: initial?.progress, err: err && err === readDismissed(meeting.id) ? null : err };
  });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!regen.busy) return undefined;
    let stop = false;
    let timer;
    async function poll() {
      if (stop) return;
      if (!document.hidden) {
        try {
          const status = await api.regenerationStatus(meeting.id);
          if (stop) return;
          if (status.state !== 'running') {
            setRegen({ busy: false, err: status.error ?? (status.state === 'idle' ? 'The regeneration was interrupted.' : null) });
            if (status.state === 'done') onReload?.();
            return;
          }
          setRegen((current) => ({ ...current, progress: status.progress }));
        } catch { /* A temporary disconnect should not end a running job. */ }
      }
      if (!stop) timer = setTimeout(poll, REGEN_POLL_MS);
    }
    void poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [regen.busy, meeting.id, onReload]);

  // Resolves true once a regeneration has started.
  const start = useCallback(async () => {
    if (starting || regen.busy) return false;
    if (!window.confirm('Regenerate the summary with the current summarizer settings? The current notes will be replaced; action items you already checked off stay checked if they reappear.')) return false;
    setStarting(true);
    try {
      await api.regenerateSummary(meeting.id);
      writeDismissed(meeting.id, null); // a new failure must show again
      setRegen({ busy: true, err: null });
      return true;
    } catch (e) {
      setRegen({ busy: false, err: e?.message || 'Regeneration failed.' });
      return false;
    } finally {
      setStarting(false);
    }
  }, [starting, regen.busy, meeting.id]);

  const dismiss = useCallback(() => {
    writeDismissed(meeting.id, regen.err);
    setRegen((r) => ({ ...r, err: null }));
  }, [meeting.id, regen.err]);

  return { ...regen, starting, start, dismiss };
}

function RegenerationProgress({ progress }) {
  const percentage = progress ? Math.floor(100 * progress.completed / progress.total) : null;
  const label = !progress ? 'Regenerating the summary…'
    : progress.stage === 'overview' && progress.overviewCompleted < progress.overviewTotal
      ? `Combining the overview (${progress.overviewCompleted} of ${progress.overviewTotal} passes complete)…`
      : progress.completed === progress.total ? 'Saving the summary…'
        : `${progress.completed} of ${progress.total} transcript chunks complete (${percentage}%)`;

  return (
    <div className="card p-4 mt-8 text-[13.5px] text-muted">
      <div className="flex items-center gap-3" role="status">
        <span className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
        <div>
          <p>{label}</p>
          {progress?.estimatedFinishAt && (
            <p>Estimated finish around {fmtTime(progress.estimatedFinishAt)} · {fmtMs(progress.remainingMs)} left</p>
          )}
        </div>
      </div>
      {progress?.chunkDurationsMs.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer">Chunk timings</summary>
          <ol className="ml-5 mt-1 list-decimal">
            {progress.chunkDurationsMs.map((ms, index) => <li key={index}>{fmtMs(ms)}</li>)}
          </ol>
        </details>
      )}
    </div>
  );
}

function findTodo(todos, item) {
  return todos.find((t) => t.task === item.task && (t.assignee ?? null) === (item.assignee ?? null))
    ?? todos.find((t) => t.task === item.task) ?? null;
}

function Note({ data, onReload }) {
  const { meeting, summary, attendees, utterances, retry } = data;
  const notes = summary?.notes;
  const duration = fmtDuration(meeting.started_at, meeting.ended_at);
  const todos = data.todos ?? [];
  const { progress, watching, outcome, watchRetry } = useMeetingProgress(meeting, data.progress, onReload);
  const lines = useMemo(() => [...(utterances ?? [])].sort((a, b) => a.start_ms - b.start_ms), [utterances]);
  const playable = data.hasAudio && data.audioOriginMs != null;
  const isAdmin = useIsAdmin();
  const running = !!progress;
  const isFailed = !running && !watching && ['transcription_failed', 'summary_failed', 'processing'].includes(meeting.status);
  const regen = useRegeneration(meeting, data.regenerate, onReload);
  const { start: startRegeneration } = regen;
  // Offer "Regenerate notes with these names" after a rename, until it's used.
  const [namesSaved, setNamesSaved] = useState(false);
  const regenerateSummary = useCallback(async () => {
    if (await startRegeneration()) setNamesSaved(false);
  }, [startRegeneration]);

  return (
    <article className="max-w-[760px] mx-auto pb-12 animate-fade-up">
      <Link to="/meetings" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink mb-5 no-underline">
        <Icon.Arrow width={14} height={14} className="rotate-180" /> All meetings
      </Link>

      <header>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="chip">
                {meeting.source === 'import' ? <Icon.Upload width={12} height={12} /> : <Icon.Hash width={12} height={12} />}
                {meeting.channel_name}
              </span>
              {meeting.source === 'import' && <span className="chip">Imported</span>}
            </div>
            <h1 className="font-display text-[30px] font-extrabold text-ink leading-tight tracking-tight">{fmtDateLong(meeting.started_at)}</h1>
            <p className="text-sm text-muted mt-1.5 flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5"><Icon.Clock width={14} height={14} />{fmtTime(meeting.started_at)}{duration && ` · ${duration}`}</span>
              {attendees?.length > 0 && <span className="inline-flex items-center gap-1.5"><Icon.Users width={14} height={14} />{attendees.length} attendees</span>}
            </p>
          </div>
          <MeetingActions meeting={meeting} regenerate={data.regenerate}
            regenerating={regen.starting || regen.busy} onRegenerate={regenerateSummary} hasAudio={data.hasAudio} onReload={onReload} />
        </div>

        {attendees?.length > 0 && (
          <div className="flex items-center gap-2 mt-4">
            <AvatarStack names={attendees.map((a) => a.display_name)} size={28} max={8} />
          </div>
        )}
      </header>

      {meeting.source === 'import' && isAdmin && attendees?.length > 0 && (
        <SpeakerNamesPanel key={attendees.map((a) => `${a.user_id}=${a.display_name}`).join('|')}
          meeting={meeting} attendees={attendees} saved={namesSaved} onSaved={() => setNamesSaved(true)}
          canRegenerate={!!data.regenerate?.eligible && !regen.busy && !regen.starting}
          onRegenerate={regenerateSummary} onReload={onReload} />
      )}
      {isFailed && <RetryBanner meeting={meeting} retry={retry} outcome={outcome} onStarted={watchRetry} />}
      {running && !regen.busy && <p className="card p-4 mt-8 text-sm text-muted" role="status"><ProgressText progress={progress} /></p>}
      {watching && !running && <p className="card p-4 mt-8 text-sm text-muted" role="status">Retry queued…</p>}
      {summary && meeting.status === 'done' &&
        <DiscordDelivery meeting={meeting} summary={summary} target={data.deliveryTarget} onReload={onReload} busy={running || regen.busy} />}

      {regen.busy && <RegenerationProgress progress={regen.progress} />}
      {regen.err && (
        <div className="card p-4 mt-8 border-l-2 flex items-start gap-3" style={{ borderColor: 'var(--error)' }} role="alert">
          <Icon.Alert width={18} height={18} className="text-error shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Couldn't regenerate the summary</p>
            <p className="text-[13px] text-error mt-1">{regen.err}</p>
            <p className="text-[13px] text-muted mt-1">The previous notes were kept.</p>
          </div>
          <button onClick={regen.dismiss} className="btn btn-ghost !py-1 !px-2 text-xs shrink-0">Dismiss</button>
        </div>
      )}

      {!notes && !isFailed && <p className="text-sm text-muted mt-8">No summary available — status: {meeting.status}.</p>}

      {notes && (
        <>
          {notes.tldr && <p className="text-[16px] text-ink leading-relaxed mt-8 font-medium">{notes.tldr}</p>}

          {notes.topics?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-4">Topics</h2>
              <div className="space-y-5">
                {notes.topics.map((t, i) => (
                  <div key={i} className="relative pl-4 border-l-2" style={{ borderColor: 'var(--border-strong)' }}>
                    <h3 className="text-[15px] font-semibold text-ink">{t.title}</h3>
                    {t.points?.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {t.points.map((p, j) => (
                          <li key={j} className="text-[14px] text-ink-2 leading-relaxed flex gap-2">
                            <span className="text-faint mt-2 h-1 w-1 rounded-full bg-current shrink-0" />{p}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {notes.decisions?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-3">Decisions</h2>
              <ul className="space-y-2">
                {notes.decisions.map((d, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[14.5px] text-ink leading-relaxed">
                    <Icon.Check width={16} height={16} className="text-accent mt-0.5 shrink-0" />{d}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {notes.openQuestions?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-3">Open questions</h2>
              <ul className="space-y-2">
                {notes.openQuestions.map((q, i) => (
                  <li key={i} className="text-[14.5px] text-ink leading-relaxed flex gap-2.5">
                    <span className="text-warn font-bold shrink-0">?</span>{q}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {notes.actionItems?.length > 0 && (
            <section className="mt-9 card p-5">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-4">
                <Icon.CheckSquare width={16} height={16} className="text-primary" /> Action items
              </h2>
              <ul className="space-y-3">
                {notes.actionItems.map((item, i) => (
                  <ActionItem key={`${i}:${item.task}`} item={item} todo={findTodo(todos, item)} onToggle={onReload} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {summary?.talktime?.length > 0 && (
        <section className="mt-9">
          <h2 className="text-sm font-bold text-ink mb-4">Talk time</h2>
          <div className="mb-3"><TalkBar talktime={summary.talktime} height={8} /></div>
          <div className="space-y-2.5">
            {summary.talktime.map((t, i) => (
              <div key={i} className="flex items-center gap-3">
                <Avatar name={t.displayName} size={24} />
                <span className="text-[13.5px] text-ink flex-1">{t.displayName}</span>
                <span className="text-xs text-muted tabular-nums">{fmtMs(t.ms)}</span>
                <span className="text-xs font-semibold tabular-nums w-10 text-right" style={{ color: colorOf(t.displayName) }}>{t.pct}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <RecordingTranscript meetingId={meeting.id} lines={lines} originMs={playable ? data.audioOriginMs : null} />
      {meeting.guild_id && <AskBox guildId={meeting.guild_id} meetingId={meeting.id} />}
      <MeetingNav neighbors={data.neighbors} />
    </article>
  );
}

function DiscordDelivery({ meeting, summary, target, onReload, busy }) {
  const isAdmin = useIsAdmin();
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const status = meeting.delivery_status;
  const previousVersion = status === 'posted' && meeting.delivery_summary_at !== summary.created_at;
  const label = previousVersion ? 'An earlier summary was posted to Discord.' : {
    posted: 'Posted to Discord.',
    sending: 'Posting to Discord…',
    failed: 'Discord delivery failed. Your notes are saved here.',
    unknown: 'Discord delivery could not be confirmed.',
  }[status] || 'No Discord delivery recorded.';

  async function post() {
    const warning = status ? ' An earlier attempt may already have sent some or all of the notes.' : '';
    const destination = target?.name ? `#${target.name}` : target?.id ? `Discord channel ${target.id}` : 'the configured Discord destination';
    if (!window.confirm(`Post these saved notes to ${destination}?${warning}`)) return;
    setPosting(true); setError(null);
    try {
      await api.postMeetingNotes(meeting.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
      onReload?.();
    }
  }

  return (
    <section className="card mt-5 p-3 flex flex-wrap items-center justify-between gap-2" aria-label="Discord delivery">
      <div className="text-sm text-muted">
        <p role="status">{label}</p>
        {(error || meeting.delivery_error) && <p className="text-xs text-error" role="alert">{error || meeting.delivery_error}</p>}
      </div>
      {isAdmin &&
        <button className="btn btn-ghost" onClick={post} disabled={!target || busy || posting || status === 'sending'}>
          {posting ? 'Posting…' : 'Post to Discord'}
        </button>}
    </section>
  );
}

function NoteSkeleton() {
  return (
    <div className="max-w-[760px] mx-auto pb-12 px-6 md:px-8 py-7">
      <div className="h-3 w-24 skeleton mb-6" />
      <div className="h-5 w-20 skeleton mb-3 rounded-full" />
      <div className="h-9 w-72 skeleton mb-3" />
      <div className="h-4 w-48 skeleton mb-8" />
      <div className="space-y-2.5 mb-8">
        <div className="h-4 w-full skeleton" /><div className="h-4 w-11/12 skeleton" /><div className="h-4 w-9/12 skeleton" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="mb-8">
          <div className="h-4 w-28 skeleton mb-3" />
          <div className="space-y-2"><div className="h-4 w-full skeleton" /><div className="h-4 w-10/12 skeleton" /></div>
        </div>
      ))}
    </div>
  );
}

export default function Reading() {
  const { id } = useParams();
  const validId = MEETING_ID.test(id ?? '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reloadError, setReloadError] = useState(null);
  // The meeting carries its own guild, todos and prev/next neighbours, so this
  // page never depends on the server switcher (a deep link or reload into
  // another server's meeting keeps working). `current` tags each request with
  // the id it was made for so a slow response for the previous meeting can't
  // replace the one now on screen.
  const current = useRef(id);
  current.current = id;

  const reloadMeeting = useCallback(() => {
    const forId = id;
    api.meeting(forId)
      .then((m) => { if (current.current === forId) { setData(m); setReloadError(null); } })
      // Keep showing what we have; say the refresh failed instead of hiding it.
      .catch((e) => { if (current.current === forId) setReloadError(e?.message || 'Could not refresh this meeting.'); });
  }, [id]);

  useEffect(() => {
    let stale = false;
    setError(null); setReloadError(null); setData(null);
    if (!validId) return undefined;
    api.meeting(id)
      .then((m) => { if (!stale) setData(m); })
      .catch((e) => { if (!stale) setError(e?.message || 'Failed to load meeting'); });
    return () => { stale = true; };
  }, [id, validId]);

  if (!validId) return (
    <div className="px-8 py-10">
      <Empty icon={Icon.Doc} title="Meeting not found" body="There's no meeting at this address."
        action={<Link to="/meetings" className="btn btn-primary !py-2">All meetings</Link>} />
    </div>
  );
  if (error) return <div className="px-8 py-10"><Empty icon={Icon.Doc} title="Couldn't load meeting" body={error} /></div>;
  if (!data) return <NoteSkeleton />;

  return (
    <div className="px-6 md:px-8 py-7">
      {reloadError && <p className="max-w-[760px] mx-auto mb-3 text-xs text-error" role="alert">{reloadError}</p>}
      <Note key={data.meeting.id} data={data} onReload={reloadMeeting} />
    </div>
  );
}
