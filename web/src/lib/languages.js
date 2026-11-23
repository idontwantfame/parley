// Spoken-language choices for transcription (ISO codes the STT engines accept)
// and summary languages. Shared by Settings and the recording import form.
export const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese']];
export const SUMMARY_LANGS = [['match', 'Match transcription'], ...LANGS.filter(([c]) => c !== 'auto')];
