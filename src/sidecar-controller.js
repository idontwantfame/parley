// src/sidecar-controller.js
// Owns the local faster-whisper STT sidecar process so the web UI can start and
// stop it on demand. Mirrors BotController.
//
// Design notes:
//   • "Managed" only when the sidecar URL is local AND the Python venv exists.
//     In Docker the sidecar is a separate container (no venv in the bot image,
//     URL points at the `stt` service), so this controller reports managed:false
//     and never tries to spawn — the container orchestrator owns it there.
//   • start() health-checks first. If something is already listening (e.g. you
//     ran `npm run sidecar` yourself, or a leftover process), we adopt it as
//     "external" instead of spawning a duplicate and colliding on the port.
//   • stop() only kills a process WE spawned; it can't kill an external one. It
//     waits for that process to exit (SIGTERM, then SIGKILL), so a restart never
//     finds the dying process still answering /health and adopts it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config/env.js';
import { sttAuthHeaders, SIDECAR_NEEDS_KEY } from './adapters/stt-access.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(host);
}

const DEFAULT_STT_URL = 'http://127.0.0.1:8000';
const HEALTH_POLL_MS = 500;
// How long stop() waits for our child to exit after SIGTERM (the sidecar
// finishes its in-flight request), and then after SIGKILL.
const STOP_WAIT_MS = 10_000;
const KILL_WAIT_MS = 2_000;
export const STILL_STOPPING_ERROR = 'The previous sidecar is still shutting down; try again in a moment.';

// Resolves true once `exited` settles, or false after `ms`.
function waitForExit(exited, ms) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, ms, false); });
  return Promise.race([exited.then(() => true), timedOut]).finally(() => clearTimeout(timer));
}

function signal(child, name) {
  try { child.kill(name); } catch { /* already gone */ }
}

export class SidecarController {
  // `sttUrl` may be a string or a function returning the current URL — pass a
  // function so a URL changed later in the dashboard reaches this controller.
  constructor({ sttUrl, deps = {} } = {}) {
    this.urlSource = typeof sttUrl === 'function' ? sttUrl : () => sttUrl;
    this.spawnImpl = deps.spawn || spawn;
    this.pollMs = deps.pollMs ?? HEALTH_POLL_MS;
    this.starting = null;    // in-flight start() promise (single-flight)
    this.generation = 0;     // bumped by stop(); a start() from an older generation gives up
    this.fetchImpl = deps.fetch || fetch;
    this.exists = deps.exists || existsSync;
    this.stopWaitMs = deps.stopWaitMs ?? STOP_WAIT_MS;
    this.killWaitMs = deps.killWaitMs ?? KILL_WAIT_MS;
    this.authHeaders = deps.authHeaders || (() => sttAuthHeaders());
    this.exits = new WeakMap(); // child -> promise settled on its 'exit'
    this.stopping = null;       // in-flight stop() (waiting for our child to exit)
    this.unconfirmed = null;    // a child we signalled whose exit never arrived
    this.pythonPath = deps.pythonPath || join(ROOT, 'stt_sidecar', '.venv', 'bin', 'python');
    this.serverPath = deps.serverPath || join(ROOT, 'stt_sidecar', 'server.py');

    this.child = null;       // process we spawned (null if external/none)
    this.external = false;   // true once we adopt an already-running sidecar
    this.state = 'stopped';  // 'stopped' | 'starting' | 'running' | 'error'
    this.error = null;
    this.logTail = [];       // last few stdout/stderr lines for the UI
    this.health = null;      // last /health body: { device, compute, model, batch_size }
  }

  get sttUrl() { return this.urlSource() || DEFAULT_STT_URL; }

  // Local + venv present => we can manage the process here.
  managed() {
    let host;
    try { host = new URL(this.sttUrl).hostname; } catch { return false; }
    return isLocalHost(host) && this.exists(this.pythonPath) && this.exists(this.serverPath);
  }

  _bind() {
    const u = new URL(this.sttUrl);
    return { host: u.hostname === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1', port: u.port || '8000' };
  }

  async healthy(timeoutMs = 1500) {
    try {
      const res = await this.fetchImpl(`${this.sttUrl.replace(/\/+$/, '')}/health`, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(timeoutMs),
      });
      // Capture the health body (device/compute/model/batch_size) so the UI can
      // show whether STT is on GPU or the slow CPU fallback. Best-effort: older
      // sidecars or the test fake may not return JSON.
      if (res.ok) {
        try { this.health = typeof res.json === 'function' ? await res.json() : null; } catch { /* keep last */ }
      } else {
        // Read the error body so the connection is released.
        await res.text?.().catch(() => {});
      }
      return res.ok;
    } catch { return false; }
  }

  _pushLog(line) {
    for (const l of String(line).split(/\r?\n/)) {
      const t = l.trim();
      if (t) { this.logTail.push(t); if (this.logTail.length > 20) this.logTail.shift(); }
    }
  }

  // Start the sidecar if it isn't already up. Idempotent and single-flight:
  // concurrent calls share one attempt. Resolves once /health responds (or the
  // spawn fails / times out). A health timeout keeps the child tracked — a
  // first run downloads the model and can outlast it — so a later start() waits
  // on that same process and stop() can still kill it (no orphan on the port).
  start({ waitMs = 60_000 } = {}) {
    if (this.state === 'running') return Promise.resolve({ ok: true, state: this.state });
    if (!this.starting) {
      this.starting = this._start(waitMs).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async _start(waitMs) {
    // A restart: let our previous process finish exiting first, so the probe
    // below can't mistake it for an already-running sidecar.
    if (this.stopping) await this.stopping;
    const generation = this.generation;
    // Already serving (started by us earlier, by the user, or another process)?
    const healthy = await this.healthy();
    // stop() ran during the probe (e.g. SIGTERM right after boot): don't spawn a
    // process nobody will ever kill.
    if (generation !== this.generation) return { ok: false, error: 'Sidecar was stopped.' };
    if (healthy) return this._adoptResponder();
    if (!this.child) {
      const spawned = this._spawn();
      if (!spawned.ok) return spawned;
    }
    this.state = 'starting'; this.error = null;
    return this._awaitHealthy(waitMs);
  }

  // Something answers /health: our own child, or an external sidecar. Never
  // adopt our own signalled-but-not-exited process as "external".
  _adoptResponder() {
    if (!this.child && this.unconfirmed) {
      this.state = 'error'; this.error = STILL_STOPPING_ERROR;
      return { ok: false, error: this.error };
    }
    if (!this.child) this.external = true;
    this.state = 'running'; this.error = null;
    return { ok: true, state: this.state, external: this.external };
  }

  _spawn() {
    if (!this.managed()) {
      this.state = 'error';
      this.error = this.exists(this.pythonPath)
        ? `STT_URL (${this.sttUrl}) is not local; this sidecar is managed elsewhere.`
        : 'Local sidecar is not installed (no Python venv). See README "Set up the Python STT sidecar".';
      return { ok: false, error: this.error };
    }
    const { host, port } = this._bind();
    try {
      const child = this.spawnImpl(this.pythonPath, [this.serverPath], {
        env: { ...process.env, STT_HOST: host, STT_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      this.external = false;
      this.exits.set(child, new Promise((resolve) => child.once('exit', resolve)));
      child.stdout?.on('data', (d) => this._pushLog(d.toString()));
      child.stderr?.on('data', (d) => this._pushLog(d.toString()));
      child.on('exit', (code) => {
        // Only reflect an unexpected exit; a deliberate stop() nulls this.child first.
        if (this.child === child) {
          this.child = null;
          if (this.state !== 'stopped') { this.state = 'error'; this.error = `Sidecar exited (code ${code}).`; }
        }
      });
      child.on('error', (e) => {
        // A failed spawn (e.g. ENOENT) may never emit 'exit' — forget it here.
        if (this.child === child) this.child = null;
        this.error = e.message; this.state = 'error';
      });
      return { ok: true };
    } catch (e) {
      this.state = 'error'; this.error = e.message;
      return { ok: false, error: e.message };
    }
  }

  // Poll /health until it comes up (model import + boot can take a while).
  async _awaitHealthy(waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.state === 'error') return { ok: false, error: this.error };
      if (this.state === 'stopped') return { ok: false, error: 'Sidecar was stopped.' };
      if (await this.healthy()) { this.state = 'running'; return { ok: true, state: 'running' }; }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    if (this.state !== 'starting') return { ok: false, error: this.error || 'Sidecar was stopped.' };
    this.state = 'error';
    this.error = 'Sidecar did not become healthy in time (it may still be downloading the model — Start again to keep waiting).';
    return { ok: false, error: this.error };
  }

  // Stop a sidecar WE spawned and wait for it to exit (SIGTERM, then SIGKILL).
  // An adopted external process is left alone.
  async stop() {
    const child = this.child;
    this.generation++;
    this.state = 'stopped'; this.error = null;
    if (this.stopping) return this.stopping;
    if (child) {
      this.child = null;
      this.stopping = this._terminate(child).finally(() => { this.stopping = null; });
      return this.stopping;
    }
    if (this.external) {
      this.external = false;
      return { ok: true, state: 'stopped', note: 'External sidecar left running (not managed by this process).' };
    }
    return { ok: true, state: 'stopped' };
  }

  async _terminate(child) {
    const exited = this.exits.get(child) ?? Promise.resolve();
    signal(child, 'SIGTERM');
    if (await waitForExit(exited, this.stopWaitMs)) return { ok: true, state: 'stopped' };
    signal(child, 'SIGKILL');
    if (await waitForExit(exited, this.killWaitMs)) return { ok: true, state: 'stopped' };
    // Still not gone: remember it so start() won't adopt it as external.
    this.unconfirmed = child;
    exited.then(() => { if (this.unconfirmed === child) this.unconfirmed = null; });
    return { ok: false, state: 'stopped', error: 'The sidecar process did not exit after SIGKILL.' };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  status() {
    const h = this.health || {};
    // The sidecar refuses requests without the key Parley doesn't have.
    const needsKey = h.auth === 'key' && !config.sttApiKey;
    return {
      state: this.state,
      error: this.error ?? (needsKey ? SIDECAR_NEEDS_KEY : null),
      running: this.state === 'running',
      managed: this.managed(),
      external: this.external,
      url: this.sttUrl,
      log: this.logTail.slice(-5),
      // From the sidecar's /health, so the UI can flag slow CPU fallback / show
      // the active model + batch size. null until the first successful health check.
      device: h.device ?? null,
      compute: h.compute ?? null,
      model: h.model ?? null,
      batchSize: h.batch_size ?? null,
    };
  }
}
