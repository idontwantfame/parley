import { transcribeFile } from '../stt-client.js';

// The local faster-whisper sidecar provider. Thin wrapper over the existing
// stt-client so the resolver can treat every provider uniformly as
// `(filePath, { model, language }) => { text, words }`. Imported recordings
// also pass { diarize, minSpeakers, maxSpeakers } (speaker detection).
export function createSidecarSTT({ baseUrl }, deps = {}) {
  return function transcribe(filePath, opts = {}) {
    const { model, language, vocabulary, diarize, minSpeakers, maxSpeakers } = opts;
    return transcribeFile(filePath, { model, language, vocabulary, diarize, minSpeakers, maxSpeakers }, { ...deps, baseUrl });
  };
}
