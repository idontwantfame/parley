import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useSystem = () => useContext(Ctx);

const STARTING_POLL_MS = 1500;
const ERROR_RETRY_MS = 5000;
// What an older server without /system/status is treated as: fully configured,
// so the app still renders (the endpoint is additive).
const LEGACY_STATUS = { managed: false, bot: { hasCreds: true, connected: false } };

export function SystemProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastJson = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.systemStatus();
      // Skip identical polls so the whole routed tree doesn't re-render every
      // 1.5s while the bot or sidecar is starting.
      const serialized = JSON.stringify(s);
      if (serialized !== lastJson.current) {
        lastJson.current = serialized;
        setStatus(s);
      }
      setError(null);
      return s;
    } catch (e) {
      if (e?.status === 404) {
        setStatus((cur) => cur || LEGACY_STATUS);
        setError(null);
      } else {
        // A transient failure must not masquerade as "fully configured" (that
        // would skip onboarding and show read-only mode). Keep what we had and
        // surface the error; the retry effect below tries again.
        setError(e?.message || 'Could not load server status.');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // While the bot is connecting after onboarding, or the local sidecar is
  // booting (model load takes a few seconds), poll until it settles. After a
  // failed status request, retry on a slower timer.
  // 'stopping' can last minutes: a stop waits for in-flight meeting pipelines.
  const botStarting = Boolean(status?.managed && ['starting', 'stopping'].includes(status.bot?.state));
  const sidecarStarting = status?.sidecar?.state === 'starting';
  const pollMs = botStarting || sidecarStarting ? STARTING_POLL_MS : error ? ERROR_RETRY_MS : null;
  // Hidden tabs skip the poll; becoming visible again refreshes immediately.
  useEffect(() => {
    if (!pollMs) return undefined;
    function tick() {
      if (!document.hidden) void refresh();
    }
    const t = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pollMs, refresh]);

  const value = useMemo(() => ({ status, error, loading, refresh }), [status, error, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
