"""diarize.py's model lifecycle, driven by a fake backend (no whisperx).

The WhisperX specifics live in whisperx_backend.py; these tests pin down the
lifecycle around it: a cheap availability report, a lazy load-once under a
lock, a remembered (and retried) load failure, and one labelling at a time.
"""
import threading
import time

import numpy as np
import pytest

import diarize


SEGMENTS = [{"start": 0.0, "end": 1.0, "text": " hi", "words": [{"word": " hi", "start": 0.0, "end": 1.0}]}]


class FakeBackend:
    def __init__(self, reason=None, speaker="SPEAKER_00", load_error=None, load_delay=0.0):
        self.reason = reason
        self.speaker = speaker
        self.load_error = load_error
        self.load_delay = load_delay
        self.loads = 0
        self.calls = []

    def unavailable_reason(self):
        return self.reason

    def load(self):
        self.loads += 1
        time.sleep(self.load_delay)
        if self.load_error:
            raise self.load_error
        def label(segments, audio, language, min_speakers, max_speakers):
            self.calls.append((segments, audio, language, min_speakers, max_speakers))
            return [{**seg, "speaker": self.speaker} for seg in segments]
        return label


@pytest.fixture(autouse=True)
def clean_state():
    diarize._state.update(labeller=None, error=None)
    yield
    diarize._state.update(labeller=None, error=None)


def use(monkeypatch, backend):
    monkeypatch.setattr(diarize, "BACKEND", backend)
    return backend


# ── cheap availability report (/health) ──────────────────────────────────────

def test_status_reports_the_backends_reason_without_loading(monkeypatch):
    backend = use(monkeypatch, FakeBackend(reason="HF_TOKEN is not set"))
    assert diarize.status() == {"available": False, "reason": "HF_TOKEN is not set"}
    assert backend.loads == 0


def test_status_is_available_without_loading_the_model(monkeypatch):
    backend = use(monkeypatch, FakeBackend())
    assert diarize.status() == {"available": True, "reason": None}
    assert backend.loads == 0


def test_check_available_raises_the_backends_reason(monkeypatch):
    backend = use(monkeypatch, FakeBackend(reason="pyannote is not installed"))
    with pytest.raises(diarize.DiarizationUnavailable, match="pyannote is not installed"):
        diarize.check_available()
    assert backend.loads == 0


# ── lazy load ────────────────────────────────────────────────────────────────

def test_concurrent_first_requests_load_the_backend_once(monkeypatch):
    backend = use(monkeypatch, FakeBackend(load_delay=0.1))
    got = []
    threads = [threading.Thread(target=lambda: got.append(diarize.get_labeller())) for _ in range(4)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert backend.loads == 1
    assert len({id(d) for d in got}) == 1


def test_load_failure_is_reported_and_retried_on_the_next_request(monkeypatch):
    use(monkeypatch, FakeBackend(load_error=RuntimeError("401 Client Error: accept the terms")))
    with pytest.raises(diarize.DiarizationUnavailable) as err:
        diarize.get_labeller()
    assert "401 Client Error: accept the terms" in str(err.value)
    assert diarize.status() == {"available": False, "reason": str(err.value)}
    # Fixing the cause (e.g. accepting the model terms) must not need a restart.
    use(monkeypatch, FakeBackend())
    diarize.get_labeller()
    assert diarize.status() == {"available": True, "reason": None}


def test_multiline_load_errors_become_a_single_line_reason(monkeypatch):
    use(monkeypatch, FakeBackend(load_error=RuntimeError("Could not download.\n\n  Visit https://hf.co/x")))
    with pytest.raises(diarize.DiarizationUnavailable) as err:
        diarize.get_labeller()
    assert "\n" not in str(err.value)
    assert "Could not download. Visit https://hf.co/x" in str(err.value)


def test_get_diarizer_refuses_before_loading_when_the_backend_is_unavailable(monkeypatch):
    backend = use(monkeypatch, FakeBackend(reason="not installed"))
    with pytest.raises(diarize.DiarizationUnavailable):
        diarize.get_labeller()
    assert backend.loads == 0


# ── labelling speakers ───────────────────────────────────────────────────────

def test_label_speakers_forwards_everything_and_returns_labelled_segments(monkeypatch):
    backend = use(monkeypatch, FakeBackend())
    audio = np.zeros(48000, dtype=np.float32)
    labelled = diarize.label_speakers(SEGMENTS, audio, "en", min_speakers=2, max_speakers=4)
    assert labelled == [{**SEGMENTS[0], "speaker": "SPEAKER_00"}]
    diarize.label_speakers(SEGMENTS, audio, "de")
    assert [(segs is SEGMENTS, a is audio, lang, lo, hi) for segs, a, lang, lo, hi in backend.calls] == [
        (True, True, "en", 2, 4), (True, True, "de", None, None)]


def test_empty_audio_is_returned_unlabelled_without_running(monkeypatch):
    backend = use(monkeypatch, FakeBackend())
    assert diarize.label_speakers(SEGMENTS, np.zeros(0, dtype=np.float32), "en") == SEGMENTS
    assert backend.calls == []


def test_only_one_labelling_runs_at_a_time(monkeypatch):
    running, peak, lock = [0], [0], threading.Lock()
    class SlowBackend(FakeBackend):
        def load(self):
            def label(segments, audio, language, lo, hi):
                with lock:
                    running[0] += 1; peak[0] = max(peak[0], running[0])
                time.sleep(0.05)
                with lock:
                    running[0] -= 1
                return segments
            return label
    use(monkeypatch, SlowBackend())
    audio = np.zeros(16000, dtype=np.float32)
    threads = [threading.Thread(target=lambda: diarize.label_speakers(SEGMENTS, audio, "en")) for _ in range(3)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert peak[0] == 1


def test_whisperx_is_the_default_backend():
    import whisperx_backend
    assert isinstance(diarize.BACKEND, whisperx_backend.WhisperXBackend)
