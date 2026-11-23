import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { useGuild } from './GuildContext.jsx';

const Ctx = createContext(null);
export const useLive = () => useContext(Ctx);

const POLL_MS = 4000;
const PROCESSING_POLL_MS = 2000;
const EMPTY = [];

// Polls the bot's in-progress recordings for the active guild. Live recording
// state lives only in the bot's memory (transcription runs at meeting end), so
// this gives the dashboard a real-time view: who's recording, for how long, and
// a one-click Stop. Polls every 4s normally, 2s while a session is processing
// (so completion feels snappy), and pauses entirely while the tab is hidden
// (refreshing immediately on return) — D5.
export function LiveProvider({ children }) {
  const { guildId } = useGuild();
  const [live, setLive] = useState(EMPTY);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const lastJson = useRef('[]');
  // Incremented per request so a slow response for a previously selected
  // guild can never overwrite the current guild's sessions.
  const seq = useRef(0);

  const apply = useCallback((rows) => {
    // Most polls return the same (usually empty) list; only update state when
    // it changed so consumers (nav, dashboard) don't re-render every tick.
    const serialized = JSON.stringify(rows);
    if (serialized === lastJson.current) return;
    lastJson.current = serialized;
    setLive(rows.length ? rows : EMPTY);
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    if (!guildId) { apply(EMPTY); return; }
    try {
      const { live: rows } = await api.live(guildId);
      if (mine !== seq.current) return;
      apply(Array.isArray(rows) ? rows : EMPTY);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      // A read-only/standalone server (401) or an older server without the live
      // endpoint (404) has no live data — treat as "nothing recording" rather
      // than surfacing an error. Only real failures show a message.
      apply(EMPTY);
      if (e?.status === 401 || e?.status === 404) setError(null);
      else setError(e?.message || null);
    }
  }, [guildId, apply]);

  // Poll faster while anything is actively processing (completion should feel
  // snappy), slower otherwise. The interval is recreated whenever this rate
  // changes.
  const pollMs = live.some((s) => s.phase === 'processing') ? PROCESSING_POLL_MS : POLL_MS;

  useEffect(() => {
    // Switching guilds: drop the previous guild's sessions immediately.
    apply(EMPTY);
    refresh();
  }, [refresh, apply]);

  useEffect(() => {
    function start() {
      clearInterval(timer.current);
      // Skip polling entirely when there's no guild selected (nothing to poll)
      // or the tab is hidden. Refreshes immediately when either changes.
      if (!document.hidden && guildId) timer.current = setInterval(refresh, pollMs);
    }
    function onVisibilityChange() {
      if (!document.hidden) refresh();
      start();
    }
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, pollMs, guildId]);

  const stop = useCallback(async (channelId) => {
    await api.stopLive(guildId, channelId);
    await refresh();
  }, [guildId, refresh]);

  const value = useMemo(() => ({ live, error, refresh, stop }), [live, error, refresh, stop]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
