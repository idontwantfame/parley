import { lazy, Suspense } from 'react';
import ErrorBoundary from './ErrorBoundary.jsx';

// The Markdown renderer is the largest dependency in the dashboard; fetch it
// only when something is actually rendered as Markdown (an answer, a journal).
const Markdown = lazy(() => import('./Markdown.jsx'));

/** Markdown, loaded on demand. Shows the plain text until (or if) it can't load. */
export default function LazyMarkdown({ text, className = '' }) {
  const plain = <div className={`whitespace-pre-wrap ${className}`}>{String(text ?? '')}</div>;
  return (
    <ErrorBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <Markdown text={text} className={className} />
      </Suspense>
    </ErrorBoundary>
  );
}
