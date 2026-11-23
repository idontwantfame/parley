"""Fakes shared by the sidecar's endpoint tests: no real Whisper, WhisperX or GPU."""
import copy
import io
import struct
import wave

import pytest
from fastapi.testclient import TestClient

import diarize
import server
from server import app, _state


def make_silent_wav(seconds=1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack("<" + "h" * rate * seconds, *([0] * rate * seconds)))
    buf.seek(0)
    return buf


class FakeModel:
    def transcribe(self, path, **kwargs):
        seg = type("S", (), {"text": "hello world", "start": 0.0, "end": 1.0,
                             "words": [type("W", (), {"word": "hello", "start": 0.0, "end": 0.5})()]})()
        info = type("I", (), {"language": "en"})()
        return [seg], info


def reset_state():
    _state.update(model=None, model_name=None, device=None, compute=None, batched=None, batched_for=None)


class FakeDiarizationBackend:
    """Stands in for WhisperX: labels by overlap with `turns`, leaving words and
    segments that overlap no turn unlabelled (as whisperx.assign_word_speakers does)."""
    def __init__(self, reason=None, turns=(), load_error=None):
        self.reason, self.turns, self.load_error = reason, list(turns), load_error
        self.loads, self.calls = 0, []

    def unavailable_reason(self):
        return self.reason

    def _speaker(self, item):
        hits = [(min(item["end"], e) - max(item["start"], s), spk) for s, e, spk in self.turns
                if min(item["end"], e) > max(item["start"], s)]
        return max(hits)[1] if hits else None

    def _label(self, item):
        speaker = self._speaker(item)
        return {**item, "speaker": speaker} if speaker else dict(item)

    def load(self):
        self.loads += 1
        if self.load_error:
            raise self.load_error
        def label(segments, audio, language, min_speakers, max_speakers):
            self.calls.append((copy.deepcopy(segments), audio, language, min_speakers, max_speakers))
            return [{**self._label(seg), "words": [self._label(w) for w in seg["words"]]} for seg in segments]
        return label


class TwoSpeakerModel:
    """Alice says 'hi there' (0-1 s), Bob answers 'hello' (2-3 s)."""
    def __init__(self):
        self.inputs = []

    def transcribe(self, audio, **kwargs):
        self.inputs.append(audio)
        W = lambda word, start, end: type("W", (), {"word": word, "start": start, "end": end})()
        S = lambda text, start, end, words: type("S", (), {"text": text, "start": start, "end": end, "words": words})()
        segs = [S(" hi there", 0.0, 1.0, [W(" hi", 0.0, 0.4), W(" there", 0.5, 1.0)]),
                S(" hello", 2.0, 3.0, [W(" hello", 2.0, 3.0)])]
        return segs, type("I", (), {"language": "en"})()


@pytest.fixture
def speaker_env(monkeypatch):
    diarize._state.update(labeller=None, error=None)
    model = TwoSpeakerModel()
    monkeypatch.setattr(server, "get_model", lambda name: model)
    monkeypatch.setattr(server, "get_batched", lambda m: None)
    def with_backend(backend):
        monkeypatch.setattr(diarize, "BACKEND", backend)
        return backend
    yield model, with_backend
    diarize._state.update(labeller=None, error=None)


def post_wav(data=None, headers=None):
    return TestClient(app).post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")},
                                data=data or {}, headers=headers or {})
