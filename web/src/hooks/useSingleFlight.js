import { useCallback, useRef, useState } from 'react';

/**
 * Runs one async action at a time. A second call while the first is still in
 * flight (a double click, Enter pressed twice, a confirm() queued behind
 * another) is ignored, which a `busy` state alone can't guarantee because it
 * only updates on the next render. Returns [busy, run].
 */
export function useSingleFlight() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
