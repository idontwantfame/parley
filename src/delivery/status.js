export async function deliverSavedNotes(db, meetingId, send) {
  const summary = db.getSummary(meetingId);
  if (!summary || !db.beginDelivery(meetingId, summary.created_at)) return { conflict: true };
  try {
    await send(summary.notes, summary.talktime);
  } catch (error) {
    const deliveryError = error.message || String(error);
    db.finishDelivery(meetingId, 'failed', deliveryError);
    console.error(`[delivery] meeting ${meetingId}: ${deliveryError}`);
    return { delivered: false, deliveryError };
  }
  db.finishDelivery(meetingId, 'posted');
  return { delivered: true, deliveryError: null };
}
