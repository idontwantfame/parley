import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { api } from '../api.js';
import { Logo } from '../components/ui.jsx';

// Why single sign-on bounced back here (?authError=<code> from the server).
const SSO_ERRORS = {
  sso_disabled: 'Single sign-on is turned off.',
  state_mismatch: 'The sign-in took too long or was started in another tab. Please try again.',
  provider_error: 'Your identity provider didn’t complete the sign-in. Try again, or ask an admin to check the SSO settings.',
  not_allowed: 'Your account isn’t in a group that’s allowed to use Parley.',
  no_account: 'There’s no Parley account for you yet. Ask an admin to create one.',
  account_conflict: 'Your sign-in couldn’t be matched to a Parley account. Ask an admin.',
};

// Read the SSO error once and drop it from the address bar, so a reload or a
// bookmark doesn't show a stale message.
function takeSsoError() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('authError');
  if (!code) return null;
  params.delete('authError');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  return SSO_ERRORS[code] || 'Single sign-on failed. Please try again.';
}

function SsoButton({ label }) {
  // Come back to the page the visitor was trying to open.
  const returnTo = `${window.location.pathname}${window.location.search}` || '/';
  return (
    <a href={api.ssoLoginUrl(returnTo)} className="btn btn-primary !py-2.5 w-full justify-center no-underline">
      {label}
    </a>
  );
}

function PasswordForm({ login }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await login(username.trim(), password);
      // AuthProvider flips user → app re-renders into the dashboard.
    } catch (e2) {
      setErr(e2?.message || 'Login failed.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="login-username" className="block text-[13px] font-medium text-ink mb-1.5">Username</label>
        <input id="login-username" className="input" value={username} autoComplete="username"
          onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
      </div>
      <div>
        <label htmlFor="login-password" className="block text-[13px] font-medium text-ink mb-1.5">Password</label>
        <input id="login-password" className="input" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      </div>
      {err && <p className="text-sm text-error bg-error-soft rounded-sm px-3 py-2" role="alert">{err}</p>}
      <button type="submit" disabled={busy || !username.trim() || !password}
        className="btn btn-primary !py-2.5 w-full justify-center">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export default function Login() {
  const { login, defaultPasswordActive, sso, passwordLogin } = useAuth();
  const [ssoError] = useState(takeSsoError);
  const showPassword = passwordLogin || !sso.enabled;

  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <Logo size={40} />
          <span className="font-display text-2xl font-extrabold tracking-tight">Parley</span>
        </div>

        <div className="card p-7">
          <h1 className="font-display text-[22px] font-extrabold leading-tight mb-1">Sign in</h1>
          <p className="text-sm text-muted mb-6">
            {sso.enabled && !showPassword ? 'Use your organization account to access the dashboard.' : 'Sign in to access the dashboard.'}
          </p>
          {ssoError && <p className="text-sm text-error bg-error-soft rounded-sm px-3 py-2 mb-4" role="alert">{ssoError}</p>}

          {sso.enabled && <SsoButton label={sso.label} />}
          {sso.enabled && showPassword && (
            <div className="flex items-center gap-3 my-5 text-[11px] text-faint uppercase tracking-wider">
              <span className="h-px flex-1 bg-border" />or with a password<span className="h-px flex-1 bg-border" />
            </div>
          )}
          {showPassword && <PasswordForm login={login} />}
        </div>

        {defaultPasswordActive && showPassword && (
          <p className="text-[11px] text-faint text-center leading-relaxed mt-5">
            First time? The default account is <code className="text-muted">admin</code> / <code className="text-muted">admin</code>.
            You'll be asked to change it right after you sign in.
          </p>
        )}
      </div>
    </div>
  );
}
