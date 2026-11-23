// Keywords from a natural-language question, for full-text search (campaign
// Q&A) and for picking the relevant part of a long meeting transcript (/ask).
const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from
further had has have having he her here hers herself him himself his how i if in into is it its itself
just me more most my myself no nor not now of off on once only or other our ours ourselves out over own
same she should so some such than that the their theirs them themselves then there these they this
those through to too under until up very was we were what when where which while who whom why will
with would you your yours yourself yourselves ever never also still yet again ago last first next
tell remind know remember happened happen happens said say says thing things get got go went going
party session sessions campaign game time did does anyone someone something name named called`.split(/\s+/));

/** Search terms from a natural-language question (lowercased, deduped, stopwords dropped). */
export function extractTerms(question, max = 8) {
  const words = String(question).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const out = [];
  for (const w of words) {
    const t = w.replace(/['’]s$/, '').replace(/['’-]+$/, '');
    if (t.length < 3 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
