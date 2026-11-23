import { useState } from 'react';
import { api } from '../api.js';

/* ── Local sidecar status + on/off control ─────────────────────────────────
   The sidecar is the local faster-whisper process. It's a single global backend
   (not per-guild), so this lives off `sys.sidecar` from /system/status. Shows a
   live state pill and a Start/Stop button; hidden entirely when the sidecar is
   unmanaged here (e.g. running as its own Docker container). */
export default function SidecarControl({ sys, onChanged }) {
  const sc = sys?.sidecar;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!sc) return null; // standalone web server with no controller attached

  const map = {
    running: { label: 'Running', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    starting: { label: 'Starting…', color: 'var(--warn)', bg: 'var(--warn-soft)' },
    error: { label: 'Stopped', color: 'var(--error)', bg: 'var(--error-soft)' },
    stopped: { label: 'Stopped', color: 'var(--muted)', bg: 'var(--surface-3)' },
  };
  const s = map[sc.state] || map.stopped;
  const running = sc.state === 'running';

  async function act(action) {
    setBusy(true); setErr(null);
    try { await api.sidecarAction(action); await onChanged?.(); }
    catch (e) { setErr(e?.message || `Failed to ${action} sidecar`); }
    finally { setBusy(false); }
  }

  if (!sc.managed) {
    return (
      <div className="rounded-md bg-surface-2 px-3.5 py-3 text-xs text-muted">
        The local whisper sidecar is managed outside this process
        {sc.url ? <> (<code className="text-ink-2">{sc.url}</code>)</> : null}. In Docker it runs as its
        own container and starts/stops with <code className="text-ink-2">docker compose</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink">Local sidecar</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.bg }}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: s.color }} />
            {s.label}{sc.external ? ' · external' : ''}
          </span>
          {running && sc.device && <DeviceBadge device={sc.device} model={sc.model} batchSize={sc.batchSize} />}
        </div>
        <div className="flex items-center gap-2">
          {running
            ? <button onClick={() => act('stop')} disabled={busy} className="btn btn-ghost !py-1.5">{busy ? '…' : 'Stop'}</button>
            : <button onClick={() => act('start')} disabled={busy} className="btn btn-primary !py-1.5">{busy ? 'Starting…' : 'Start sidecar'}</button>}
          {running && <button onClick={() => act('restart')} disabled={busy} className="btn btn-ghost !py-1.5">Restart</button>}
        </div>
      </div>
      <p className="text-xs text-muted mt-2">
        {running
          ? 'Transcribing locally on this machine. Turn it off to free CPU/RAM when using a cloud API.'
          : 'Off. Start it to transcribe locally without a cloud API.'}
      </p>
      {running && sc.device === 'cpu' && (
        <p className="text-xs mt-2 rounded-sm px-2.5 py-2" style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}>
          ⚠ Running on <b>CPU</b> — transcription is roughly 7x slower than GPU and is the usual cause of
          lag on longer meetings. If this machine has an NVIDIA GPU, install the CUDA libraries so the
          sidecar can use it (see the README GPU section).
        </p>
      )}
      {(err || sc.error) && <p className="text-xs text-error mt-1.5">{err || sc.error}</p>}
    </div>
  );
}

// Small pill showing the STT compute backend + model + batch size, so users can
// see at a glance whether transcription is GPU-accelerated (fast) or on the CPU
// fallback (slow). Green for cuda, muted/amber for cpu.
function DeviceBadge({ device, model, batchSize }) {
  const gpu = device === 'cuda';
  const color = gpu ? 'var(--accent)' : 'var(--warn)';
  const bg = gpu ? 'var(--accent-soft)' : 'var(--warn-soft)';
  const label = gpu ? 'GPU' : device === 'cpu' ? 'CPU' : device;
  const detail = [model, batchSize ? `batch ${batchSize}` : null].filter(Boolean).join(' · ');
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ color, background: bg }} title={`STT on ${device}${detail ? ` (${detail})` : ''}`}>
      {label}{detail ? <span className="opacity-70">· {detail}</span> : null}
    </span>
  );
}
