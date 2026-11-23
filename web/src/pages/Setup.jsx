import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Field from '../components/Field.jsx';
import { LANGS, SUMMARY_LANGS } from '../lib/languages.js';
import { useGuild } from '../GuildContext.jsx';
import { useAuth, useIsAdmin } from '../AuthContext.jsx';
import { useSystem } from '../SystemContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionForm, BotStatusBadge } from '../components/Connection.jsx';
import SecretEditor from '../components/SecretEditor.jsx';
import SidecarControl from '../components/SidecarControl.jsx';

const WHISPER = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];

// Model defaults come from the server (adapters/summarizer/models.js) so the
// dashboard, /setup and the adapters can't drift apart.
// Providers whose key is editable from the UI (Ollama is keyless/local).
const KEYED = {
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const KEY_HELP = {
  gemini: 'aistudio.google.com/apikey',
  openai: 'platform.openai.com/api-keys',
  opencode: 'opencode.ai/zen',
  openrouter: 'openrouter.ai/keys',
};
// Which env secret each STT provider needs (sidecar is keyless/local).
const STT_KEY = { openai: 'openai' };
const STT_HELP = {
  sidecar: 'Runs the local faster-whisper container. Free and fully offline, but uses your CPU.',
  openai: 'OpenAI (or any OpenAI-compatible) transcription endpoint.',
};
// The provider's model catalog, fetched live (and re-fetchable with refresh,
// which bypasses the server's cache). `seq` drops responses that land after the
// provider already changed.
function useCatalog(provider) {
  const [state, setState] = useState({ catalog: null, loading: !!provider });
  const seq = useRef(0);
  const load = useCallback((refresh) => {
    const mine = ++seq.current;
    if (!provider) { setState({ catalog: null, loading: false }); return; }
    setState((s) => ({ ...s, loading: true }));
    api.providerModels(provider, refresh)
      .then((catalog) => { if (seq.current === mine) setState({ catalog, loading: false }); })
      .catch(() => { if (seq.current === mine) setState({ catalog: null, loading: false }); });
  }, [provider]);
  useEffect(() => { load(false); }, [load]);
  return { catalog: state.catalog, loading: state.loading, reload: () => load(true) };
}


function Card({ title, desc, children }) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-bold text-ink">{title}</h2>
        {desc && <p className="text-xs text-muted mt-0.5">{desc}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

// Settings the server reserves for admins: other users see the current values
// with every control disabled instead of controls that would just fail (403).
function AdminFieldset({ isAdmin, children }) {
  return (
    <fieldset disabled={!isAdmin} className="space-y-4 min-w-0">
      {!isAdmin && <p className="text-xs text-muted">Only admins can change these settings.</p>}
      {children}
    </fieldset>
  );
}

// value is the server's own prompt, or null when it uses the built-in default.
function PromptEditor({ label, hint, value, defaultValue, maxLength = 20000, rows = 10, onSave }) {
  const current = value ?? defaultValue;
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const changed = draft !== current;
  useEffect(() => { setDraft(current); }, [current]);

  async function savePrompt(next) {
    setBusy(true);
    const ok = await onSave(next);
    if (ok) setDraft(next ?? defaultValue);
    setBusy(false);
  }

  return (
    <Field label={label} hint={hint}>
      <textarea className="input font-mono text-xs resize-y" aria-label={label} rows={rows}
        value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={maxLength} />
      <div className="flex flex-wrap gap-2 mt-2">
        <button type="button" className="btn btn-primary" disabled={busy || !changed || !draft.trim()}
          onClick={() => savePrompt(draft.trim())}>Save prompt</button>
        <button type="button" className="btn btn-ghost" disabled={busy || value == null}
          onClick={() => savePrompt(null)}>Restore default</button>
        {changed && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDraft(current)}>Discard changes</button>}
      </div>
    </Field>
  );
}

function VocabularyUpload() {
  const { user, authEnabled } = useAuth();
  const [vocabulary, setVocabulary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef(null);
  function load() {
    setError('');
    api.vocabulary().then(r => setVocabulary(r.vocabulary)).catch(e => setError(e.message));
  }
  useEffect(load, []);

  async function save(text) {
    const result = await api.importVocabulary(text);
    setVocabulary(result.vocabulary);
    setMessage(text ? 'Vocabulary imported. Applies to all servers and re-transcriptions.' : 'Vocabulary cleared.');
  }
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (!/\.(md|txt)$/i.test(file.name)) throw new Error('Choose a .md or .txt file, with one term per line.');
      if (file.size > 65536) throw new Error('Choose a file no larger than 64 KB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim()) throw new Error('The file has no vocabulary terms.');
      await save(text);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function clear() {
    setBusy(true); setError(''); setMessage('');
    try { await save(''); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return (
    <Card title="Transcription vocabulary" desc="One shared list for all servers. Upload a .md or .txt file with one term per line.">
      {vocabulary === null ? <p className="text-xs text-muted">{error ? 'Could not load vocabulary.' : 'Loading…'}</p> :
        vocabulary ? <pre className="text-xs text-ink-2 bg-surface-2 rounded-md p-3 max-h-48 overflow-auto whitespace-pre-wrap">{vocabulary}</pre> :
          <p className="text-xs text-muted">No vocabulary imported.</p>}
      {(!authEnabled || user?.isAdmin) && <div className="flex gap-2">
        <input ref={fileInput} type="file" accept=".md,.txt,text/plain,text/markdown" onChange={upload} className="sr-only" aria-label="Upload vocabulary" />
        <button className="btn btn-primary" disabled={busy || vocabulary === null} onClick={() => fileInput.current?.click()}>{busy ? 'Saving…' : 'Import vocabulary'}</button>
        {!!vocabulary && <button className="btn btn-ghost" disabled={busy} onClick={clear}>Clear</button>}
      </div>}
      <p className="text-xs text-muted">Uploading replaces the list. Changes apply to new transcriptions and retries that transcribe audio again. Keep important terms first: Whisper only uses the beginning of long lists.</p>
      {message && <p className="text-xs text-accent" role="status">{message}</p>}
      {error && <p className="text-xs text-error" role="alert">{error} {vocabulary === null && <button className="underline" onClick={load}>Retry</button>}</p>}
    </Card>
  );
}

function Switch({ checked, onChange, label, desc, disabled }) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {desc && <span className="block text-xs text-muted mt-0.5">{desc}</span>}
      </span>
      <span className="relative shrink-0 mt-0.5">
        <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="peer sr-only" />
        <span className="block h-6 w-10 rounded-full bg-surface-3 peer-checked:bg-primary transition-colors
          peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary
          peer-disabled:opacity-50" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

function Chevron() {
  return <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />;
}

/* ── API key editor ───────────────────────────────────────────────────────
   A provider's key, saved to .env and applied live. Never read back. */
function KeyEditor({ provider, present, onChanged, autoEdit = false }) {
  const envVar = KEYED[provider];
  return (
    <SecretEditor label="API key" present={present} autoEdit={autoEdit}
      hint={<>Stored in <code className="text-ink-2">.env</code> as <code className="text-ink-2">{envVar}</code> · get one at {KEY_HELP[provider]}</>}
      inputLabel={`${provider} API key`} placeholder={`Paste ${provider} API key…`}
      removeConfirm={`Remove the ${provider} API key from .env?`}
      onSave={async (key) => { await api.setProviderKey(provider, key); onChanged?.(); }} />
  );
}

// Shared secret the sidecar can require (its STT_API_KEY) so other devices on
// the network can't use it. Write-only, like the provider keys.
function SidecarKeySetting({ present, onSaved }) {
  return (
    <SecretEditor label="Sidecar access key" present={present} addText="Set key"
      hint="Optional. Set the same STT_API_KEY on the sidecar to stop other devices on your network from using it."
      inputLabel="Sidecar access key" placeholder="Paste the sidecar's STT_API_KEY…"
      removeConfirm="Remove the sidecar access key? Parley will call the sidecar without one."
      onSave={async (key) => { await api.setConnection({ sttApiKey: key }); await onSaved?.(); }} />
  );
}

/* ── Connection card (server-wide Discord + STT settings) ────────────────── */
function ConnectionCard({ sys, onChanged }) {
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartErr, setRestartErr] = useState(null);
  const bot = sys?.bot;
  const conn = sys?.connection;
  if (!sys?.managed) {
    return (
      <Card title="Connection" desc="Discord bot connection.">
        <p className="text-sm text-muted">
          This dashboard is running in read-only mode (no bot process attached), so the Discord
          connection is managed elsewhere. Start Parley with <code className="text-ink-2">npm start</code> to
          edit it here.
        </p>
        {bot && <div className="mt-2"><BotStatusBadge bot={bot} /></div>}
      </Card>
    );
  }
  async function restart() {
    setRestarting(true); setRestartErr(null);
    try { await api.botAction('restart'); await onChanged?.(); }
    catch (e) { setRestartErr(e?.status === 403 ? 'Only admins can reconnect the bot.' : (e?.message || 'Reconnect failed.')); }
    finally { setRestarting(false); }
  }
  return (
    <Card title="Connection" desc="Your Discord bot. Changes reconnect instantly.">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {bot && <BotStatusBadge bot={bot} />}
          {bot?.guildCount > 0 && <span className="text-xs text-muted">{bot.guildCount} server{bot.guildCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={restart} disabled={restarting} className="btn btn-ghost !py-1.5">{restarting ? 'Reconnecting…' : 'Reconnect'}</button>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost !py-1.5">{open ? 'Close' : 'Edit credentials'}</button>
        </div>
      </div>
      {bot?.state === 'error' && bot?.error && <p className="text-xs text-error mt-2">{bot.error}</p>}
      {restartErr && <p className="text-xs text-error mt-2" role="alert">{restartErr}</p>}
      {open && (
        <div className="mt-4 pt-4 border-t border-border">
          <ConnectionForm conn={conn} submitLabel="Save & reconnect" onSaved={async () => { setOpen(false); await onChanged?.(); }} />
        </div>
      )}
    </Card>
  );
}

export default function Setup() {
  const { user, authEnabled } = useAuth();
  const isAdmin = useIsAdmin();
  const { guildId } = useGuild();
  const { status: sys, refresh: refreshSys } = useSystem();
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  // "Draft" providers: when you pick a cloud provider that has no API key yet,
  // we stage the choice (reveal its key field) WITHOUT saving — saving would be
  // rejected server-side ("key not set"). Once the key is added we auto-commit.
  const [sumDraft, setSumDraft] = useState(null);
  const [sttDraft, setSttDraft] = useState(null);

  const [loadErr, setLoadErr] = useState(null);
  // Tags each request with the guild it was for: a slow response for the
  // previous server must never be shown (or saved back) under the new one.
  const current = useRef(guildId);
  current.current = guildId;
  const reload = useCallback(() => {
    const forGuild = guildId;
    if (!forGuild) return Promise.resolve();
    return api.config(forGuild)
      .then((d) => { if (current.current === forGuild) { setData(d); setLoadErr(null); } })
      .catch((e) => { if (current.current === forGuild) setLoadErr(e?.message || 'Could not load settings.'); });
  }, [guildId]);
  useEffect(() => {
    // Switching servers: drop the previous server's config before loading.
    setData(null); setLoadErr(null); setSumDraft(null); setSttDraft(null);
    reload();
  }, [reload]);

  // One catalog per model field: the primary provider's and the fallback's.
  const models = useCatalog(data?.config?.summarizerProvider);
  const fbModels = useCatalog(data?.config?.summarizerFallbackProvider);
  // Older servers don't report the sidecar access key; leave the field out there.
  const sttKeySet = sys?.connection?.sttApiKeySet;
  const sidecarUrlSetting = (!authEnabled || user?.isAdmin) && (
    <>
      <ServiceUrlSetting setting="sttUrl" label="Whisper sidecar URL" onSaved={refreshSys}
        url={sys?.connection?.sttUrl?.value} placeholder="http://sidecar:8000"
        hint="Use an address reachable from Parley. An empty value restores http://127.0.0.1:8000." />
      {typeof sttKeySet === 'boolean' && <SidecarKeySetting present={sttKeySet} onSaved={refreshSys} />}
    </>
  );

  if (!guildId) return (
    <Page max="720px">
      <PageHead title="Settings" subtitle="Discord connection and per-server configuration." />
      <ConnectionCard sys={sys} onChanged={refreshSys} />
      {sidecarUrlSetting && <div className="mt-5"><Card title="Transcription">{sidecarUrlSetting}</Card></div>}
      <div className="mt-5"><Empty icon={Icon.Settings} title="No server selected" body="Pick a server from the top bar to configure summarizer, transcription, and delivery." /></div>
    </Page>
  );
  if (!data && loadErr) return (
    <Page max="720px">
      <PageHead title="Settings" subtitle="Discord connection and per-server configuration." />
      <Empty icon={Icon.Settings} title="Couldn't load settings" body={loadErr}
        action={<button className="btn btn-primary !py-2" onClick={reload}>Retry</button>} />
    </Page>
  );
  if (!data) return (
    <Page max="720px">
      <div className="h-8 w-32 skeleton mb-7" />
      <div className="space-y-5">{[0,1,2].map(i => <div key={i} className="h-44 skeleton rounded-[14px]" />)}</div>
    </Page>
  );

  const { config: c, providers, sttProviders, channels, voiceChannels, secrets = {}, defaultModels = {}, defaultSummaryPrompt, defaultOverviewPrompt } = data;
  // `rethrow` lets a caller show the error next to its own control too.
  const save = async (patch, { rethrow = false } = {}) => {
    // The response belongs to the server it was saved for: if the switcher
    // moved on meanwhile (or the page reset), it must not land on screen.
    const forGuild = guildId;
    try {
      const r = await api.saveConfig(forGuild, patch);
      if (current.current === forGuild) setData((d) => (d ? { ...d, config: r.config } : d));
      setMsg('Saved'); setMsgErr(false);
      // Switching the transcription backend may have auto-started/stopped the
      // local sidecar; refresh system status so its pill reflects reality.
      if (patch.sttProvider !== undefined || patch.sharedMicUserIds !== undefined) refreshSys?.();
      return r;
    } catch (e) {
      setMsg(e.message); setMsgErr(true);
      if (rethrow) throw e;
      return false;
    }
    finally { setTimeout(() => setMsg(''), 2400); }
  };
  const sel = 'input appearance-none pr-9 cursor-pointer';

  // ── Summarizer provider, with draft-before-key handling ───────────────────
  const sumProvider = sumDraft || c.summarizerProvider;        // shown in the <select>
  const sumReady = (providers.find((p) => p.provider === sumProvider) || {}).ok;
  const sumKeyed = Object.prototype.hasOwnProperty.call(KEYED, sumProvider);
  function pickSummarizer(p) {
    const ready = (providers.find((x) => x.provider === p) || {}).ok;
    if (!ready && Object.prototype.hasOwnProperty.call(KEYED, p)) {
      setSumDraft(p);              // stage it; reveal the key field, don't save yet
      setMsg(''); 
    } else {
      setSumDraft(null);
      save({ provider: p, model: defaultModels[p] || '' });
    }
  }
  // After a key lands for the staged provider, commit the switch.
  async function commitSumKey() {
    await reload();
    if (sumDraft) { await save({ provider: sumDraft, model: defaultModels[sumDraft] || '' }); setSumDraft(null); }
  }

  // ── Transcription provider, same pattern ──────────────────────────────────
  const sttProvider = sttDraft || c.sttProvider;
  const sttReady = (sttProviders || []).find((p) => p.provider === sttProvider)?.ok;
  const sttKeyed = Object.prototype.hasOwnProperty.call(STT_KEY, sttProvider);
  const sttModels = (sttProviders || []).find((p) => p.provider === sttProvider)?.models || [];
  function pickStt(p) {
    const sp = (sttProviders || []).find((x) => x.provider === p);
    if (!sp?.ok && Object.prototype.hasOwnProperty.call(STT_KEY, p)) {
      setSttDraft(p);              // stage it; reveal the key field, don't save yet
      setMsg('');
    } else {
      setSttDraft(null);
      save({ sttProvider: p, sttModel: p === 'sidecar' ? null : (sp?.models?.[0] ?? null) });
    }
  }
  async function commitSttKey() {
    await reload(); refreshSys?.();
    if (sttDraft) {
      const sp = (sttProviders || []).find((x) => x.provider === sttDraft);
      await save({ sttProvider: sttDraft, sttModel: sp?.models?.[0] ?? null });
      setSttDraft(null);
    }
  }

  return (
    <Page max="720px">
      <PageHead
        title="Settings"
        subtitle="Per-server configuration. Applied instantly, no restart."
        actions={msg && <span className={`text-sm font-medium ${msgErr ? 'text-error' : 'text-accent'}`}>{msg}</span>}
      />

      <div className="space-y-5">
        <ConnectionCard sys={sys} onChanged={refreshSys} />
        <VocabularyUpload />
        <Card title="Summarizer" desc="Which AI turns transcripts into structured notes.">
          <ServiceUrlSetting setting="ollamaUrl" label="Ollama URL" url={sys?.connection?.ollamaUrl?.value}
            placeholder="http://ollama:11434" hint="Use a URL reachable from Parley. An empty value restores http://127.0.0.1:11434."
            onSaved={async () => {
              await refreshSys?.();
              if (c.summarizerProvider === 'ollama') models.reload();
              if (c.summarizerFallbackProvider === 'ollama') fbModels.reload();
            }} />
          <AdminFieldset isAdmin={isAdmin}>
          <Field label="Provider" hint={sumDraft ? 'Add the API key below to switch to this provider.' : undefined}>
            <div className="relative">
              <select className={sel} value={sumProvider}
                onChange={(e) => pickSummarizer(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {sumKeyed && <KeyEditor provider={sumProvider} present={!!secrets[sumProvider]} onChanged={commitSumKey} autoEdit={!!sumDraft} />}

          {!sumDraft && (
          <Field label="Model" hint="Type to search the provider's catalog. Any id it supports also works — press Enter to use what you typed.">
            <ModelPicker value={c.summarizerModel} catalog={models.catalog} loading={models.loading}
              onRefresh={models.reload}
              onPick={(id) => save({ provider: c.summarizerProvider, model: id })} />
          </Field>
          )}

          {/* Only providers with a working key are offered: validateSetup rejects
              a keyless fallback server-side, so listing them would just error. */}
          {!sumDraft && (
          <Field label="Fallback" hint="Tried only if the primary fails (quota cap, outage, region block). Choose none to disable.">
            <div className="relative">
              <select className={sel} value={c.summarizerFallbackProvider || 'none'}
                onChange={(e) => save({ fallbackProvider: e.target.value })}>
                <option value="none">none</option>
                {providers.filter((p) => p.ok && p.provider !== c.summarizerProvider).map((p) => (
                  <option key={p.provider} value={p.provider}>{p.provider}</option>
                ))}
              </select>
              <Chevron />
            </div>
            {c.summarizerFallbackProvider && (
              <div className="mt-2">
                <ModelPicker value={c.summarizerFallbackModel} catalog={fbModels.catalog} loading={fbModels.loading}
                  onRefresh={fbModels.reload}
                  onPick={(id) => save({ fallbackModel: id })} />
              </div>
            )}
          </Field>
          )}
          </AdminFieldset>
          {isAdmin && <PromptEditor key={guildId} label="Summary prompt" value={c.summaryPrompt}
            hint="Instructions for the transcript. Keep the JSON output shape for structured notes and todos."
            defaultValue={defaultSummaryPrompt} onSave={(summaryPrompt) => save({ summaryPrompt })} />}
          {isAdmin && (c.summarizerProvider === 'ollama' || c.summarizerFallbackProvider === 'ollama') && (
            <PromptEditor key={`overview-${guildId}`} label="Overview prompt" value={c.overviewPrompt}
              hint="Instructions for the final recap of a long Ollama summary. Ask for plain text."
              defaultValue={defaultOverviewPrompt} maxLength={2000} rows={4}
              onSave={(overviewPrompt) => save({ overviewPrompt })} />
          )}
        </Card>

        <Card title="Transcription" desc="How spoken audio becomes text.">
          <AdminFieldset isAdmin={isAdmin}>
          <Field label="Provider" hint={sttDraft ? 'Add the API key below to switch to this provider.' : (STT_HELP[sttProvider] || '')}>
            <div className="relative">
              <select className={sel} value={sttProvider}
                onChange={(e) => pickStt(e.target.value)}>
                {(sttProviders || []).map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.label || p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {sttKeyed && (
            <KeyEditor provider={STT_KEY[sttProvider]} present={!!secrets[STT_KEY[sttProvider]]} onChanged={commitSttKey} autoEdit={!!sttDraft} />
          )}

          {sttDraft ? null : c.sttProvider === 'sidecar' ? (
            <>
              <Field label="Whisper model" hint="Larger is more accurate but slower on CPU.">
                <div className="relative">
                  <select className={sel} value={c.whisperModel} onChange={(e) => save({ whisperModel: e.target.value })}>
                    {WHISPER.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Chevron />
                </div>
              </Field>
              {sidecarUrlSetting}
              <SidecarControl sys={sys} onChanged={refreshSys} />
            </>
          ) : (
            <>
              <Field label="Model" hint="Cloud transcription model.">
                <div className="relative">
                  <select className={sel} value={c.sttModel || (sttModels[0] ?? '')} onChange={(e) => save({ sttModel: e.target.value })}>
                    {sttModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Chevron />
                </div>
              </Field>
              {sys?.sidecar?.managed && sys?.sidecar?.running && (
                <SidecarControl sys={sys} onChanged={refreshSys} />
              )}
            </>
          )}
          </AdminFieldset>

          <Field label="Spoken language">
            <div className="relative">
              <select className={sel} value={c.language} onChange={(e) => save({ language: e.target.value })}>
                {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
        </Card>

        <Card title="Delivery" desc="Where and how notes are posted in Discord.">
          <AdminFieldset isAdmin={isAdmin}>
          <Field label="Notes channel">
            <div className="relative">
              <select className={sel} value={c.notesChannelId || ''} onChange={(e) => save({ notesChannelId: e.target.value || null })}>
                <option value="">(meeting's own channel)</option>
                {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          </AdminFieldset>
          <Field label="Summary language">
            <div className="relative">
              <select className={sel} value={c.summaryLanguage} onChange={(e) => save({ summary_language: e.target.value })}>
                {SUMMARY_LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          <Switch checked={c.useThread} onChange={(e) => save({ useThread: e.target.checked })}
            label="Post notes in a thread" desc="Keeps the channel tidy by threading each meeting's notes." />
        </Card>

        <Card title="Behavior">
          <AdminFieldset isAdmin={isAdmin}>
          <BotNameSetting key={`${guildId}:${c.botNickname ?? ''}`} value={c.botNickname} save={save} />
          <Switch checked={c.autoJoin} onChange={(e) => save({ autoJoin: e.target.checked })}
            label="Auto-join voice" desc="Start recording automatically when a voice channel reaches the minimum below." />
          <Field label="Minimum people to auto-join" hint="Counts people only. Set to 1 to record solo sessions automatically.">
            <form key={`${guildId}:${c.autoJoinMinPeople}`} className="flex items-center gap-2" onSubmit={(e) => {
              e.preventDefault();
              const minimum = Number(new FormData(e.currentTarget).get('minimum'));
              if (minimum !== c.autoJoinMinPeople) save({ autoJoinMinPeople: minimum });
            }}>
              <input className="input w-24" aria-label="Minimum people to auto-join" name="minimum"
                type="number" min={1} step={1} required defaultValue={c.autoJoinMinPeople} />
              <button className="btn btn-primary" type="submit">Save minimum</button>
            </form>
          </Field>
          <AutoJoinChannels key={JSON.stringify([guildId, c.autoJoinChannelIds])}
            channels={voiceChannels} selected={c.autoJoinChannelIds} save={save} />
          </AdminFieldset>
          <RecordingRetention enabled={c.keepAudio} save={save} />
        </Card>
        <SpeakerNames key={guildId} guildId={guildId} sharedMicUserIds={c.sharedMicUserIds ?? []} saveConfig={save} />
      </div>
    </Page>
  );
}

// Discord nicknames are 32 characters; "[REC] " is added while recording.
const BOT_NAME_MAX = 26;

/** The bot's nickname in this server, applied in Discord as soon as it's saved. */
function BotNameSetting({ value, save }) {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('botName') ?? '').trim();
    setSaving(true); setNote(null);
    try {
      const r = await save({ botNickname: name || null });
      if (r?.nicknameError) {
        const permission = /permission/i.test(r.nicknameError)
          ? ' Give the bot the Change Nickname permission in this server.' : '';
        setNote(`Saved, but Discord didn't apply it: ${r.nicknameError}.${permission}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Field label="Bot name"
      hint={`The bot's nickname in this server, shown as “[REC] name” while recording. Up to ${BOT_NAME_MAX} characters. Leave empty to use its Discord account name.`}>
      <form className="flex items-center gap-2" onSubmit={submit}>
        <input className="input flex-1" name="botName" aria-label="Bot name" defaultValue={value ?? ''}
          placeholder="Discord account name" autoComplete="off" />
        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save name'}</button>
      </form>
      {note && <p className="text-xs text-error mt-1.5" role="alert">{note}</p>}
    </Field>
  );
}

function AutoJoinChannels({ channels = [], selected = null, save }) {
  const [restricted, setRestricted] = useState(selected !== null);
  const [saving, setSaving] = useState(false);
  const unavailable = (selected ?? []).filter((id) => !channels.some((channel) => channel.id === id));
  const choices = [...channels, ...unavailable.map((id) => ({ id, name: `Unavailable channel (${id})` }))];

  async function submit(event) {
    event.preventDefault();
    const ids = new FormData(event.currentTarget).getAll('channel');
    setSaving(true);
    try {
      await save({ autoJoinChannelIds: restricted ? ids : null });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Field label="Auto-join channels" hint="Choose where automatic recording can start. Manual /join still works in other channels.">
      <form onSubmit={submit}>
        <select className="input" aria-label="Auto-join channel scope" value={restricted ? 'selected' : 'all'}
          onChange={(event) => setRestricted(event.target.value === 'selected')}>
          <option value="all">All voice channels</option>
          <option value="selected">Only selected voice channels</option>
        </select>
        <div hidden={!restricted}>
          {choices.length ? (
            <fieldset aria-label="Select voice channels" className="my-2 max-h-48 overflow-y-auto">
              {choices.map(({ id, name, category }) => (
                <label key={id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" className="pcheck" name="channel" value={id} defaultChecked={selected?.includes(id)} />
                  <span>{category ? `${category} / ${name}` : name}</span>
                </label>
              ))}
            </fieldset>
          ) : <p className="mt-2 text-sm text-muted">No voice channels are available.</p>}
          <p className="my-2 text-xs text-muted">With none selected, automatic recording will stay off.</p>
        </div>
        <button className="btn btn-primary mt-2" type="submit" disabled={saving}>Save channels</button>
      </form>
    </Field>
  );
}

function ServiceUrlSetting({ setting, label, url, placeholder, hint, onSaved }) {
  const { user, authEnabled } = useAuth();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  if (authEnabled && !user?.isAdmin) return null;

  async function save(event) {
    event.preventDefault();
    const { value } = event.currentTarget.elements.serviceUrl;
    setSaving(true);
    try {
      await api.setConnection({ [setting]: value });
      setMessage({ text: `${label} saved.` });
      await onSaved?.();
    } catch (error) {
      setMessage({ text: error.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Field label={label} hint={hint}>
      <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
        <input key={url} className="input min-w-0 flex-1" name="serviceUrl" aria-label={label}
          type="url" autoComplete="off" defaultValue={url} placeholder={placeholder} />
        <button type="submit" className="btn btn-primary" disabled={saving}>Save URL</button>
      </form>
      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-xs text-error' : 'text-xs text-muted'}>{message.text}</p>}
    </Field>
  );
}

function RecordingRetention({ enabled, save }) {
  const { user, authEnabled } = useAuth();
  if (authEnabled && !user?.isAdmin) return null;
  return <Switch checked={!!enabled} onChange={(event) => save({ keepAudio: event.target.checked })}
    label="Keep recordings" desc="Save audio from future completed meetings as downloadable MP3s." />;
}

function SpeakerNames({ guildId, sharedMicUserIds, saveConfig }) {
  const { user, authEnabled } = useAuth();
  const canEdit = !authEnabled || user?.isAdmin;
  const [speakers, setSpeakers] = useState(null);
  const [speakerId, setSpeakerId] = useState('');
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!canEdit) return;
    let current = true;
    api.speakerNames(guildId).then((rows) => {
      if (current) setSpeakers(rows);
    }).catch((error) => { if (current) setMessage({ text: error.message, error: true }); });
    return () => { current = false; };
  }, [guildId, canEdit]);
  // Whether the sidecar can separate voices. If the check fails, the switch
  // stays usable and the server decides when it is saved.
  const [detection, setDetection] = useState(null);
  useEffect(() => {
    if (!canEdit) return;
    let current = true;
    api.importCapability().then((cap) => { if (current) setDetection(cap); })
      .catch(() => { if (current) setDetection(null); });
    return () => { current = false; };
  }, [canEdit]);
  if (!canEdit) return null;
  const speaker = speakers?.find((row) => row.user_id === speakerId);
  const shared = sharedMicUserIds.includes(speakerId);
  // Only a sidecar that answers without speaker detection rules a shared mic
  // out up front; a stopped one is started and asked by the server on save.
  const sharedMicBlocked = !shared && detection?.available === true && !detection.speakerDetection;

  async function save(event) {
    event.preventDefault();
    const name = event.currentTarget.elements.speakerName.value;
    setSaving(true);
    try {
      const result = await api.setSpeakerName(guildId, speakerId, name);
      setSpeakers((rows) => rows.map((row) => row.user_id === speakerId ? { ...row, override: result.name } : row));
      setMessage({ text: 'Display name saved.' });
    } catch (error) {
      setMessage({ text: error.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  async function toggleSharedMic() {
    setSaving(true);
    setMessage(null);
    try {
      await saveConfig({ sharedMicUserIds: shared
        ? sharedMicUserIds.filter((id) => id !== speakerId)
        : [...sharedMicUserIds, speakerId] }, { rethrow: true });
    } catch (error) {
      setMessage({ text: error.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Speaker display names" desc="Applies to transcripts and future summaries for this server.">
      {speakers?.length === 0 && <p className="text-sm text-muted">No speakers found yet.</p>}
      {speakers?.length > 0 && (
        <form className="space-y-2" onSubmit={save}>
          <select className="input" aria-label="Discord speaker" value={speakerId}
            disabled={saving} onChange={(event) => { setSpeakerId(event.target.value); setMessage(null); }}>
            <option value="">Choose a speaker</option>
            {speakers.map((row) => <option key={row.user_id} value={row.user_id}>
              {row.display_name ?? row.user_id}{row.override ? ` → ${row.override}` : ''}
              {sharedMicUserIds.includes(row.user_id) ? ' (shared mic)' : ''}
            </option>)}
          </select>
          {speaker && (
            <Field label="Display name" hint="Leave blank to use the captured Discord name.">
              <div className="flex gap-2">
                <input key={speakerId} className="input min-w-0 flex-1" name="speakerName" aria-label="Speaker display name"
                  maxLength={80} defaultValue={speaker.override ?? ''} />
                <button type="submit" className="btn btn-primary" disabled={saving}>Save name</button>
              </div>
            </Field>
          )}
          {speaker && /^[1-9]\d{16,19}$/.test(speakerId) && (
            <Switch checked={shared} onChange={toggleSharedMic} disabled={saving || sharedMicBlocked}
              label="Shared microphone"
              desc={sharedMicBlocked
                ? `Needs speaker detection on the transcription sidecar. ${detection.reason ?? ''}`.trim()
                : 'Use WhisperX to separate voices on this Discord account’s track. Review the names before Parley generates notes.'} />
          )}
        </form>
      )}
      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-xs text-error' : 'text-xs text-muted'}>{message.text}</p>}
    </Card>
  );
}
