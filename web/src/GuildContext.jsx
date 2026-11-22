import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useGuild = () => useContext(Ctx);

export function GuildProvider({ children }) {
  const [guilds, setGuilds] = useState([]);
  const [guildId, setGuildId] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
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
        setGuilds(g);
        setGuildId((cur) => g.some(({ id }) => id === cur) ? cur : g[0]?.id ?? null);
        setError(null);
      } catch (err) {
        if (!disposed && !hasLoaded) setError(err?.message ?? 'Failed to load guilds');
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(load, 30_000);
    window.addEventListener('focus', load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);
  return <Ctx.Provider value={{ guilds, guildId, setGuildId, error, loading }}>{children}</Ctx.Provider>;
}
