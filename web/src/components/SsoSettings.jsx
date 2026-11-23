import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import Field from './Field.jsx';
import { Icon } from './ui.jsx';

const CALLBACK_PATH = '/api/auth/oidc/callback';

// The editable form, initialised from the server's settings.
function draftFrom(s) {
  return {
    ssoEnabled: Boolean(s.sso.enabled),
    issuer: s.sso.issuer || '',
    clientId: s.sso.clientId || '',
    clientSecret: '', // write-only: empty means "leave unchanged"
    publicUrl: s.publicUrl || '',
    label: s.sso.label || '',
    scopes: s.sso.scopes || '',
    groupsClaim: s.sso.groupsClaim || '',
    // The server returns a list; edit it as comma-separated text.
    allowedGroups: Array.isArray(s.sso.allowedGroups) ? s.sso.allowedGroups.join(', ') : (s.sso.allowedGroups || ''),
    adminGroup: s.sso.adminGroup || '',
    autoCreate: s.sso.autoCreate !== false,
    passwordLogin: s.passwordLogin !== false,
  };
}

function redirectUriFor(publicUrl, fallback) {
  const base = publicUrl.trim().replace(/\/+$/, '');
  return base ? `${base}${CALLBACK_PATH}` : fallback || '';
}

function StatusLine({ sso, verified }) {
  if (sso.status === 'ok') {
    return (
      <p className="text-xs text-accent flex items-center gap-1.5">
        <Icon.Check width={13} height={13} />
        {verified ? 'Connected, and confirmed by an admin signing in with these settings.' : 'Connected to your identity provider. Sign in with it once as an admin to confirm the settings.'}
      </p>
    );
  }
  if (sso.status === 'error') {
    return <p className="text-xs text-error" role="alert">Can’t reach the identity provider: {sso.error}</p>;
  }
  return <p className="text-xs text-muted">Single sign-on is off. Users sign in with a username and password.</p>;
}

function CopyField({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked: the value is still selectable */ }
  }
  return (
    <div className="flex items-center gap-2">
      <code className="input flex-1 !py-1.5 text-xs truncate select-all">{value || 'Set the dashboard URL first'}</code>
      <button type="button" className="btn btn-ghost !py-1.5" onClick={copy} disabled={!value}>
        <Icon.Copy width={14} height={14} />{copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Check({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer select-none">
      <input type="checkbox" className="pcheck mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
    </label>
  );
}

function ProviderFields({ d, set, secretSet }) {
  return (
    <>
      <Field label="Issuer URL" hint="For Authentik: https://auth.example.com/application/o/<app-slug>/">
        <input className="input" value={d.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="https://auth.example.com/application/o/parley/" />
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Client ID">
          <input className="input" value={d.clientId} onChange={(e) => set('clientId', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Client secret" hint={secretSet ? 'Saved. Type a new one to replace it.' : 'Not set yet.'}>
          <input className="input" type="password" value={d.clientSecret} onChange={(e) => set('clientSecret', e.target.value)}
            placeholder={secretSet ? '••••••••' : ''} autoComplete="new-password" />
        </Field>
      </div>
    </>
  );
}

// Automatic account creation only applies once Allowed groups is set (so a
// provider that admits everyone can't mint accounts). Judge the draft, and
// trust the server's verdict while the groups are unchanged.
function autoCreatePending(d, settings) {
  if (!d.ssoEnabled || !d.autoCreate) return false;
  const groups = d.allowedGroups.trim();
  if (!groups) return true;
  return groups === draftFrom(settings).allowedGroups.trim() && settings.sso.autoCreateEffective === false;
}

function AccessFields({ d, set, settings }) {
  const pending = autoCreatePending(d, settings);
  // Start expanded when the note below applies, so it isn't hidden.
  const [startOpen] = useState(pending);
  return (
    <details className="group" open={startOpen}>
      <summary className="text-[13px] font-medium text-ink cursor-pointer select-none">Access and admins</summary>
      <div className="space-y-4 mt-3">
        <Field label="Admin group" hint="Members become admins, checked at every sign-in. Leave empty to manage admins here by hand.">
          <input className="input" value={d.adminGroup} onChange={(e) => set('adminGroup', e.target.value)} placeholder="parley-admins" />
        </Field>
        <Field label="Allowed groups" hint="Optional, comma-separated. In Authentik you can instead bind the application to a group.">
          <input className="input" value={d.allowedGroups} onChange={(e) => set('allowedGroups', e.target.value)} placeholder="parley-users, parley-admins" />
        </Field>
        <Check checked={d.autoCreate} onChange={(v) => set('autoCreate', v)} label="Create accounts on first sign-in"
          hint="Off: only people who already have a Parley account (linked by verified email) can use single sign-on." />
        {pending && (
          <p className="text-xs text-warn" role="status">
            Accounts are created automatically only once Allowed groups is set; until then only existing accounts can sign in.
          </p>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Scopes"><input className="input" value={d.scopes} onChange={(e) => set('scopes', e.target.value)} placeholder="openid profile email" /></Field>
          <Field label="Groups claim"><input className="input" value={d.groupsClaim} onChange={(e) => set('groupsClaim', e.target.value)} placeholder="groups" /></Field>
        </div>
        <Field label="Button text"><input className="input" value={d.label} onChange={(e) => set('label', e.target.value)} placeholder="Sign in with SSO" /></Field>
      </div>
    </details>
  );
}

function SsoForm({ settings, onSaved }) {
  const [d, setD] = useState(() => draftFrom(settings));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (key, value) => setD((cur) => ({ ...cur, [key]: value }));

  async function save(event) {
    event.preventDefault();
    setBusy(true); setErr(null);
    try {
      const { clientSecret, ...rest } = d;
      onSaved(await api.saveAuthSettings(clientSecret ? { ...rest, clientSecret } : rest));
    } catch (e) {
      setErr(e?.message || 'Could not save the sign-in settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={save}>
      <StatusLine sso={settings.sso} verified={settings.ssoVerified} />
      <Check checked={d.ssoEnabled} onChange={(v) => set('ssoEnabled', v)} label="Enable single sign-on (OIDC)"
        hint="Works with Authentik, Keycloak, Authelia, Pocket ID and other OpenID Connect providers." />
      <Field label="Dashboard URL" hint="The address people use to open Parley. Your provider sends them back here.">
        <input className="input" value={d.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://parley.example.com" />
      </Field>
      <Field label="Redirect URI" hint="Paste this into your provider's application settings.">
        <CopyField value={redirectUriFor(d.publicUrl, settings.redirectUri)} />
      </Field>
      <ProviderFields d={d} set={set} secretSet={settings.sso.clientSecretSet} />
      <AccessFields d={d} set={set} settings={settings} />
      <Check checked={d.passwordLogin} onChange={(v) => set('passwordLogin', v)} label="Allow password sign-in"
        hint="You can turn it off once you've signed in with SSO as an admin, so you can't lock yourself out." />
      {settings.passwordLogin === false && settings.passwordLoginEffective && (
        <p className="text-xs text-warn" role="status">
          Pending: password sign-in stays on until an admin signs in with single sign-on using these settings.
          Changing the provider, URLs or group settings resets this.
        </p>
      )}
      {err && <p className="text-sm text-error" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save sign-in settings'}</button>
    </form>
  );
}

/** Admin card: single sign-on (OIDC) and password sign-in settings. */
export default function SsoSettings({ Card }) {
  const { refresh } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loadErr, setLoadErr] = useState(null);

  useEffect(() => {
    let stale = false;
    api.authSettings()
      .then((s) => { if (!stale) setSettings(s); })
      .catch((e) => { if (!stale) setLoadErr(e?.message || 'Could not load the sign-in settings.'); });
    return () => { stale = true; };
  }, []);

  function saved(next) {
    setSettings(next);
    refresh(); // the login screen's options may have changed
  }

  return (
    <Card title="Single sign-on" desc="Let people sign in with your identity provider (OpenID Connect). Off unless you enable it.">
      {loadErr && <p className="text-sm text-error" role="alert">{loadErr}</p>}
      {!settings && !loadErr && <div className="h-24 skeleton rounded-md" />}
      {settings && <SsoForm key={JSON.stringify(settings)} settings={settings} onSaved={saved} />}
    </Card>
  );
}
