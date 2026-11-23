import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const Ctx = createContext(null);
export const useTheme = () => useContext(Ctx);

const STORAGE_KEY = 'parley-theme';
const DEFAULT_THEME = 'dark';

function initialTheme() {
  try {
    // Allow a one-shot ?theme=light|dark override (handy for previews/links).
    // It applies to this page load only and is not persisted.
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (fromUrl === 'light' || fromUrl === 'dark') return fromUrl;
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const value = useMemo(() => ({
    theme,
    // Only an explicit user toggle is remembered across visits.
    toggle() {
      setTheme((t) => {
        const next = t === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
        return next;
      });
    },
  }), [theme]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
