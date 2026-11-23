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
//   • stop() only kills a process WE spawned; it can't kill an external one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(host);
}

const DEFAULT_STT_URL = 'http://127.0.0.1:8000';
const HEALTH_POLL_MS = 500;

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
      const res = await this.fetchImpl(`${this.sttUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      // Capture the health body (device/compute/model/batch_size) so the UI can
      // show whether STT is on GPU or the slow CPU fallback. Best-effort: older
      // sidecars or the test fake may not return JSON.
      if (res.ok) {
        try { this.health = typeof res.json === 'function' ? await res.json() : null; } catch { /* keep last */ }
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
    const generation = this.generation;
    // Already serving (started by us earlier, by the user, or another process)?
    const healthy = await this.healthy();
    // stop() ran during the probe (e.g. SIGTERM right after boot): don't spawn a
    // process nobody will ever kill.
    if (generation !== this.generation) return { ok: false, error: 'Sidecar was stopped.' };
    if (healthy) {
      if (!this.child) this.external = true;
      this.state = 'running'; this.error = null;
      return { ok: true, state: this.state, external: this.external };
    }
    if (!this.child) {
      const spawned = this._spawn();
      if (!spawned.ok) return spawned;
    }
    this.state = 'starting'; this.error = null;
    return this._awaitHealthy(waitMs);
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

  // Stop a sidecar WE spawned. An adopted external process is left alone.
  async stop() {
    const child = this.child;
    this.generation++;
    this.state = 'stopped'; this.error = null;
    if (child) {
      this.child = null;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return { ok: true, state: 'stopped' };
    }
    if (this.external) {
      this.external = false;
      return { ok: true, state: 'stopped', note: 'External sidecar left running (not managed by this process).' };
    }
    return { ok: true, state: 'stopped' };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  status() {
    const h = this.health || {};
    return {
      state: this.state,
      error: this.error,
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
