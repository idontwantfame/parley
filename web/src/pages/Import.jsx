import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { useIsAdmin } from '../AuthContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import Field from '../components/Field.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { LANGS } from '../lib/languages.js';

const MAX_SPEAKERS = 20;
const TITLE_MAX = 100;

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

// A Date as the local "YYYY-MM-DDTHH:mm" a datetime-local input expects.
function toLocalInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const titleFrom = (name) => name.replace(/\.[^.]+$/, '').trim().slice(0, TITLE_MAX);

// Whether the transcription sidecar can detect speakers (pyannote + token).
function useImportCapability() {
  const [cap, setCap] = useState({ loading: true });
  const load = () => {
    setCap({ loading: true });
    api.importCapability()
      .then((c) => setCap({ loading: false, ...c }))
      .catch((e) => setCap({ loading: false, available: false, reason: e?.message || 'Could not check the transcription sidecar.' }));
  };
  useEffect(load, []);
  return { ...cap, reload: load };
}

function CapabilityNote({ cap }) {
  if (cap.loading) return <div className="h-14 skeleton rounded-[14px] mb-5" />;
  if (!cap.available) {
    return (
      <div className="card p-4 mb-5 border-l-2" style={{ borderColor: 'var(--error)' }} role="status">
        <p className="text-sm font-semibold text-ink">Imports aren't available right now</p>
        <p className="text-[13px] text-muted mt-1">{cap.reason}</p>
        <button className="btn btn-ghost !py-1.5 mt-3" onClick={cap.reload}>Check again</button>
      </div>
    );
  }
  if (cap.speakerDetection) {
    return (
      <p className="card p-4 mb-5 text-sm text-muted flex items-center gap-2">
        <Icon.Check width={16} height={16} className="text-accent shrink-0" />
        Speaker detection (WhisperX) is ready on your transcription sidecar.
      </p>
    );
  }
  return (
    <div className="card p-4 mb-5" role="status">
      <p className="text-sm font-semibold text-ink">Speaker detection is off</p>
      <p className="text-[13px] text-muted mt-1">
        Recordings still import, with every line attributed to one speaker you can rename. To tell voices apart
        automatically, run the <b>-full</b> sidecar image with a free Hugging Face token in{' '}
        <code className="text-ink-2">HF_TOKEN</code> (see “Importing recordings” in the README).
      </p>
      {cap.reason && <p className="text-xs text-faint mt-2">{cap.reason}</p>}
      <button className="btn btn-ghost !py-1.5 mt-3" onClick={cap.reload}>Check again</button>
    </div>
  );
}

function UploadProgress({ progress }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted mt-1.5">
        {pct < 100 ? `Uploading… ${pct}%` : 'Uploaded. Starting transcription…'}
      </p>
    </div>
  );
}

// Where imported notes would be posted: the server's notes channel. An import
// has no voice channel of its own to fall back to.
function useNotesChannel(guildId) {
  const [state, setState] = useState({ loading: true, name: null });
  useEffect(() => {
    let stale = false;
    api.config(guildId)
      .then((d) => {
        if (stale) return;
        const id = d?.config?.notesChannelId;
        const channel = (d?.channels || []).find((c) => c.id === id);
        setState({ loading: false, id: id || null, name: channel?.name || null });
      })
      .catch(() => { if (!stale) setState({ loading: false, id: null, name: null }); });
    return () => { stale = true; };
  }, [guildId]);
  return state;
}

function ImportForm({ guildId, cap }) {
  const navigate = useNavigate();
  const notes = useNotesChannel(guildId);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [language, setLanguage] = useState('auto');
  const [detect, setDetect] = useState(Boolean(cap.speakerDetection));
  const [speakers, setSpeakers] = useState('');
  const [post, setPost] = useState(false);
  const [progress, setProgress] = useState(null); // 0..1 while uploading
  const [error, setError] = useState(null);
  const upload = useRef(null);

  // Leaving the page mid-upload cancels it instead of finishing in the background.
  useEffect(() => () => upload.current?.abort(), []);

  function pick(event) {
    const f = event.target.files?.[0] ?? null;
    setFile(f); setError(null);
    if (!f) return;
    setTitle(titleFrom(f.name));
    setWhen(toLocalInput(new Date(f.lastModified || Date.now())));
    if (cap.maxBytes && f.size > cap.maxBytes) setError(`That file is ${fmtSize(f.size)}; this server accepts up to ${fmtSize(cap.maxBytes)}.`);
  }

  async function submit(event) {
    event.preventDefault();
    if (!file || progress !== null) return;
    const count = detect ? Number(speakers) : 0;
    upload.current = new AbortController();
    setProgress(0); setError(null);
    try {
      const res = await api.importRecording(guildId, file, {
        title: title.trim() || undefined,
        startedAt: when ? new Date(when).toISOString() : undefined,
        language,
        post: post && notes.id ? '1' : undefined,
        filename: file.name,
        speakers: detect ? '1' : undefined,
        // A known head-count helps speaker detection a lot; leave it to the model otherwise.
        minSpeakers: count > 0 ? count : undefined,
        maxSpeakers: count > 0 ? count : undefined,
      }, { onProgress: setProgress, signal: upload.current.signal });
      navigate(`/meetings/${res.meetingId}`);
    } catch (err) {
      if (!err.cancelled) setError(err.message);
      setProgress(null);
    }
  }

  const tooBig = Boolean(file && cap.maxBytes && file.size > cap.maxBytes);
  const busy = progress !== null;
  return (
    <form className="card p-5 space-y-4" onSubmit={submit}>
      <Field label="Recording" hint={`Audio or video (MP3, M4A, WAV, OGG, MP4…)${cap.maxBytes ? `, up to ${fmtSize(cap.maxBytes)}` : ''}.`}>
        <input type="file" accept="audio/*,video/*" onChange={pick} disabled={busy} className="input" />
      </Field>
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX}
          placeholder="Imported recording" disabled={busy} />
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Recorded on" hint="Defaults to the file's date.">
          <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Spoken language">
          <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
            {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </Field>
      </div>
      <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer select-none">
        <input type="checkbox" className="pcheck mt-0.5" checked={detect} disabled={busy || !cap.speakerDetection}
          onChange={(e) => setDetect(e.target.checked)} />
        <span>
          Detect speakers (WhisperX)
          <span className="block text-xs text-muted">
            {cap.speakerDetection ? 'Labels each voice as Speaker 1, 2… so you can name them afterwards.' : 'Not set up on your sidecar; every line goes to one speaker.'}
          </span>
        </span>
      </label>
      {detect && (
        <Field label="Number of speakers" hint="Optional. If you know how many people talk, speaker detection gets it right more often.">
          <input type="number" className="input w-32" min={1} max={MAX_SPEAKERS} step={1} value={speakers}
            onChange={(e) => setSpeakers(e.target.value)} placeholder="Auto" disabled={busy} />
        </Field>
      )}
      <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer select-none">
        <input type="checkbox" className="pcheck mt-0.5" checked={post && Boolean(notes.id)}
          onChange={(e) => setPost(e.target.checked)} disabled={busy || !notes.id} />
        <span>
          Also post the notes to Discord when they're ready
          <span className="block text-xs text-muted">
            {notes.loading ? '…' : notes.id
              ? `Posted in #${notes.name || notes.id}.`
              : 'Set a notes channel in Settings → Delivery to enable this.'}
          </span>
        </span>
      </label>
      {error && <p className="text-sm text-error" role="alert">{error}</p>}
      {busy ? <UploadProgress progress={progress} /> : (
        <button type="submit" className="btn btn-primary" disabled={!file || tooBig || !cap.available}>
          <Icon.Upload width={16} height={16} />Import and transcribe
        </button>
      )}
    </form>
  );
}

export default function Import() {
  const { guildId } = useGuild();
  const isAdmin = useIsAdmin();
  const cap = useImportCapability();
  return (
    <Page max="720px">
      <PageHead title="Import a recording"
        subtitle="Transcribe and summarize a meeting recorded outside Discord. Name the speakers on the meeting page afterwards." />
      {!isAdmin ? <Empty icon={Icon.Upload} title="Admins only" body="Ask an admin to import recordings." />
        : !guildId ? <Empty icon={Icon.Upload} title="No server selected" body="Pick the server this recording belongs to in the sidebar." />
        : (
          <>
            <CapabilityNote cap={cap} />
            {!cap.loading && <ImportForm key={String(cap.speakerDetection)} guildId={guildId} cap={cap} />}
          </>
        )}
    </Page>
  );
}
