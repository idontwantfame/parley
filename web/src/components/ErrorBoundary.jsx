import { Component } from 'react';

// A lazily loaded page whose file is gone: after an update the server no
// longer has the old build's chunks, so the import fails until a reload.
// Messages differ per browser (Chrome, Firefox, Safari) and bundler (Vite's
// CSS preload, webpack-style chunk errors).
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk .* failed|ChunkLoadError/i;

export function isChunkLoadError(error) {
  return error?.name === 'ChunkLoadError' || CHUNK_ERROR.test(String(error?.message ?? ''));
}

function reload() {
  window.location.reload();
}

function Fallback({ error, fullPage }) {
  const updated = isChunkLoadError(error);
  const title = updated ? 'Parley was updated' : 'Something went wrong';
  const body = updated
    ? 'This page needs the latest version of the dashboard. Reload to continue.'
    : 'This part of the dashboard hit an unexpected error. Reloading usually fixes it.';
  return (
    <div className={fullPage ? 'min-h-screen grid place-items-center bg-bg text-ink p-6' : 'grid place-items-center px-6 py-16'}>
      <div className="card p-7 max-w-[420px] w-full text-center" role="alert">
        <h1 className="font-display text-lg font-extrabold text-ink mb-1">{title}</h1>
        <p className="text-sm text-muted mb-5">{body}</p>
        <button type="button" onClick={reload} className="btn btn-primary !py-2.5 w-full justify-center">Reload</button>
      </div>
    </div>
  );
}

/**
 * Catches render errors below it so one broken view doesn't blank the app.
 * `resetKey` clears a caught error when it changes (e.g. on navigation);
 * `fallback`, when given, replaces the default card (e.g. plain text for a
 * failed Markdown chunk).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the details for whoever opens the console; the UI stays friendly.
    console.error('[parley] view crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return <Fallback error={error} fullPage={this.props.fullPage} />;
  }
}
