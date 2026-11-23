import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

// Auth gate with graceful degradation:
//   • authEnabled === false  → the backend genuinely has no /api/auth routes
//     (an older server, signalled by a 404 on /auth/me). Skip the login screen
//     so the dashboard stays usable; real login engages once the backend
//     supports it.
//   • authEnabled === true   → require a session; show Login until one exists.
//   • error !== null         → the first /auth/me failed for a transient reason
//     (network blip, 5xx, proxy). We must NOT run open here (that would mount
//     the whole dashboard unauthenticated on any hiccup), so surface a retry
//     state instead.
//   • refreshError !== null  → a later refresh (after saving a password or the
//     SSO settings) failed transiently. The session we already have stays; the
//     layout shows a dismissible notice instead of swapping the app out.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [defaultPasswordActive, setDefaultPasswordActive] = useState(false);
  // New installs print a random first-run admin password to the server log
  // instead of using admin/admin; older servers don't send this flag.
  const [firstRunPasswordInLog, setFirstRunPasswordInLog] = useState(false);
  // Sign-in methods the server offers: single sign-on (OIDC) and passwords.
  const [sso, setSso] = useState({ enabled: false, label: '' });
  const [passwordLogin, setPasswordLogin] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  // Whether /auth/me has answered once, so later failures don't blank the app.
  const settled = useRef(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const me = await api.me();
      // `authEnabled` is sent by auth-aware servers; default true when present.
      setAuthEnabled(me.authEnabled !== false);
      setDefaultPasswordActive(!!me.defaultPasswordActive);
      setFirstRunPasswordInLog(me.firstRunPasswordInLog === true);
      setSso({ enabled: Boolean(me.sso?.enabled), label: me.sso?.label || 'Sign in with SSO' });
      setPasswordLogin(me.passwordLogin !== false);
      setUser(me.user || null);
      setRefreshError(null);
      settled.current = true;
      return me.user || null;
    } catch (e) {
      if (e?.status === 404) {
        // This server predates auth — run open rather than trapping the user on
        // a login screen it can't satisfy.
        setAuthEnabled(false);
        setUser(null);
        settled.current = true;
      } else if (e?.status === 401) {
        // Auth-aware server, just no session yet → show Login.
        setAuthEnabled(true);
        setUser(null);
        setRefreshError(null);
        settled.current = true;
      } else if (settled.current) {
        // A later refresh failed transiently: keep the current session and
        // report it without taking the app away.
        setRefreshError(e?.message || 'Could not reach the server.');
      } else {
        // Transient failure on first load: do NOT fail open. Keep auth on and
        // record the error so the gate can offer a retry.
        setUser(null);
        setError(e?.message || 'Could not reach the server.');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissRefreshError = useCallback(() => setRefreshError(null), []);

  // Retry from the "can't reach the server" card: show the spinner while the
  // request is in flight instead of flashing the Login screen.
  const retry = useCallback(() => {
    setLoading(true);
    return refresh();
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  // A 401 from any API call (expired/revoked session mid-use) clears the user so
  // the gate re-renders to <Login /> instead of stranding the current page.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username, password) => {
    const { user } = await api.login(username, password);
    setUser(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    // Hard reset: drops all in-memory provider state (guilds, live polling,
    // meetings) and guarantees the cleared cookie takes effect everywhere.
    window.location.assign('/');
  }, []);

  const value = useMemo(
    () => ({
      user, authEnabled, defaultPasswordActive, firstRunPasswordInLog, sso, passwordLogin, loading, error,
      refreshError, dismissRefreshError, refresh, retry, login, logout,
    }),
    [user, authEnabled, defaultPasswordActive, firstRunPasswordInLog, sso, passwordLogin, loading, error,
      refreshError, dismissRefreshError, refresh, retry, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// True when the signed-in user may perform admin-only actions (or when the
// server runs without auth, in which case every action is allowed).
export function useIsAdmin() {
  const { user, authEnabled } = useAuth();
  return !authEnabled || Boolean(user?.isAdmin);
}
