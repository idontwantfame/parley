import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useGuild = () => useContext(Ctx);

const REFRESH_MS = 30_000;
const STORAGE_KEY = 'parley-guild';

function readStoredGuild() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function storeGuild(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable — selection just won't persist */ }
}

export function GuildProvider({ children }) {
  const [guilds, setGuilds] = useState([]);
  // Remember the last selected server so a reload or deep link doesn't fall
  // back to whichever guild the API happens to list first.
  const [guildId, setGuildIdState] = useState(readStoredGuild);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastJson = useRef(null);

  const setGuildId = useCallback((id) => {
    setGuildIdState(id);
    storeGuild(id);
  }, []);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let hasLoaded = false;
    async function load() {
      if (pending || disposed) return;
      pending = true;
      try {
        const g = await api.guilds();
        if (disposed) return;
        hasLoaded = true;
        // The list rarely changes; skip identical refreshes so every consumer
        // doesn't re-render on each 30s poll and window focus.
        const serialized = JSON.stringify(g);
        if (serialized !== lastJson.current) {
          lastJson.current = serialized;
          setGuilds(g);
        }
        setGuildIdState((cur) => {
          const next = g.some(({ id }) => id === cur) ? cur : g[0]?.id ?? null;
          if (next !== cur) storeGuild(next);
          return next;
        });
        setError(null);
      } catch (err) {
        if (!disposed && !hasLoaded) setError(err?.message ?? 'Failed to load guilds');
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    // Background tabs skip the periodic refresh; coming back refreshes at once.
    function tick() {
      if (!document.hidden) void load();
    }
    void load();
    const timer = setInterval(tick, REFRESH_MS);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', tick);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const value = useMemo(
    () => ({ guilds, guildId, setGuildId, error, loading }),
    [guilds, guildId, setGuildId, error, loading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
