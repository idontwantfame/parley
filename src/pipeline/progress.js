const active = new Map();

export function meetingProgress(id) {
  const current = active.get(id);
  if (!current) return null;
  const { startedAt, ...progress } = current;
  const elapsed = Date.now() - startedAt;
  const etaSeconds = progress.stage === 'transcribing' && progress.completed >= 3
    && progress.completed < progress.total && elapsed >= 10_000
    ? Math.ceil((elapsed / progress.completed) * (progress.total - progress.completed) / 1000)
    : null;
  return { ...progress, etaSeconds };
}

export async function withMeetingProgress(id, total, work) {
  if (active.has(id)) throw new Error('This meeting is already being processed.');
  const progress = { stage: total === null ? 'summarizing' : 'transcribing',
    total, completed: 0, failed: 0, startedAt: Date.now() };
  active.set(id, progress);
  try {
    return await work(progress);
  } finally {
    active.delete(id);
  }
}
