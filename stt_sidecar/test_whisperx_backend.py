"""whisperx_backend.py with whisperx and torch faked out: no network, token or GPU."""
import copy
import sys
import threading
import time
import types

import numpy as np
import pytest

import whisperx_backend

AUDIO = np.zeros(48000, dtype=np.float32)
SEGMENTS = [
    {"start": 0.0, "end": 1.0, "text": " hi there",
     "words": [{"word": " hi", "start": 0.0, "end": 0.4}, {"word": " there", "start": 0.5, "end": 1.0}]},
    {"start": 2.0, "end": 3.0, "text": " hello", "words": [{"word": " hello", "start": 2.0, "end": 3.0}]},
]
TURNS = [(0.0, 1.2, "SPEAKER_01"), (1.8, 3.0, "SPEAKER_00")]


class FakeWhisperX:
    """Records calls; aligns by nudging every word 0.01 s later."""

    def __init__(self, turns=TURNS, align_error=None, align_load_error=None, align_load_delay=0.0):
        self.turns = turns
        self.align_error = align_error  # callable(segment) -> Exception | None
        self.align_load_error = align_load_error
        self.align_load_delay = align_load_delay
        self.align_loads, self.align_calls, self.pipelines, self.diarize_calls, self.assigned = [], [], [], [], []
        self.cache_empties = []

    def load_align_model(self, language_code, device, **kwargs):
        self.align_loads.append((language_code, device))
        time.sleep(self.align_load_delay)
        if self.align_load_error:
            raise self.align_load_error
        return f"align-model-{language_code}", {"language": language_code}

    def align(self, transcript, model, metadata, audio, device, **kwargs):
        self.align_calls.append((transcript, model, device))
        seg = transcript[0]
        error = self.align_error and self.align_error(seg)
        if error:
            raise error
        words = [{"word": w.strip(), "start": round(i * 0.3 + seg["start"] + 0.01, 3),
                  "end": round(i * 0.3 + seg["start"] + 0.25, 3), "score": 0.9}
                 for i, w in enumerate(seg["text"].split())]
        return {"segments": [{"start": words[0]["start"], "end": words[-1]["end"], "text": seg["text"].strip(),
                              "words": words}], "word_segments": words}

    def assign_word_speakers(self, diarize_df, transcript_result, fill_nearest=False):
        # Like whisperx: mutate in place, label by overlap, leave unmatched unlabelled.
        self.assigned.append((diarize_df, copy.deepcopy(transcript_result)))
        def speaker(start, end):
            hits = [(min(end, e) - max(start, s), spk) for s, e, spk in diarize_df if min(end, e) > max(start, s)]
            return max(hits)[1] if hits else None
        for seg in transcript_result["segments"]:
            if speaker(seg["start"], seg["end"]):
                seg["speaker"] = speaker(seg["start"], seg["end"])
            for w in seg["words"]:
                if speaker(w["start"], w["end"]):
                    w["speaker"] = speaker(w["start"], w["end"])
        return transcript_result

    def pipeline_class(self):
        fake = self
        class DiarizationPipeline:
            def __init__(self, model_name=None, token=None, device="cpu", cache_dir=None):
                fake.pipelines.append({"model_name": model_name, "token": token, "device": device})
            def __call__(self, audio, num_speakers=None, min_speakers=None, max_speakers=None):
                fake.diarize_calls.append((audio, min_speakers, max_speakers))
                return list(fake.turns)
        return DiarizationPipeline


def install(monkeypatch, fake, cuda=False):
    top = types.ModuleType("whisperx")
    top.load_align_model, top.align = fake.load_align_model, fake.align
    top.assign_word_speakers = fake.assign_word_speakers
    diarize_mod = types.ModuleType("whisperx.diarize")
    diarize_mod.DiarizationPipeline = fake.pipeline_class()
    alignment = types.ModuleType("whisperx.alignment")
    alignment.DEFAULT_ALIGN_MODELS_TORCH = {"en": "WAV2VEC2_ASR_BASE_960H", "fr": "VOXPOPULI_ASR_BASE_10K_FR"}
    alignment.DEFAULT_ALIGN_MODELS_HF = {"ja": "jonatasgrosman/wav2vec2-large-xlsr-53-japanese"}
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda,
                                       empty_cache=lambda: fake.cache_empties.append(True))
    for name, mod in {"whisperx": top, "whisperx.diarize": diarize_mod,
                      "whisperx.alignment": alignment, "torch": torch}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: True)
    return fake


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_test_token")
    for name in ("DIARIZATION_MODEL", "STT_DEVICE", "PYANNOTE_METRICS_ENABLED", "HF_HUB_OFFLINE"):
        monkeypatch.setenv(name, "")  # recorded first, so teardown restores the real value
        monkeypatch.delenv(name)      # even after the backend sets it directly


def labeller(monkeypatch, fake=None, cuda=False):
    fake = install(monkeypatch, fake or FakeWhisperX(), cuda=cuda)
    return whisperx_backend.WhisperXBackend().load(), fake


# ── cheap availability (no whisperx import) ──────────────────────────────────

def test_whisperx_installed_is_false_when_the_package_is_missing(monkeypatch):
    whisperx_backend.whisperx_installed.cache_clear()
    monkeypatch.setattr(whisperx_backend.importlib.util, "find_spec", lambda name: None)
    try:
        assert whisperx_backend.whisperx_installed() is False
    finally:
        whisperx_backend.whisperx_installed.cache_clear()


def test_unavailable_without_whisperx_points_to_the_full_image(monkeypatch):
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: False)
    reason = whisperx_backend.WhisperXBackend().unavailable_reason()
    assert "WhisperX is not installed" in reason and "-full" in reason


@pytest.mark.parametrize("token", [None, "", "  "])
def test_unavailable_without_a_hugging_face_token(monkeypatch, token):
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: True)
    if token is None:
        monkeypatch.delenv("HF_TOKEN")
    else:
        monkeypatch.setenv("HF_TOKEN", token)
    assert "HF_TOKEN" in whisperx_backend.WhisperXBackend().unavailable_reason()


@pytest.mark.parametrize("offline", ["1", "true", "ON", "yes"])
def test_offline_mode_needs_no_token_because_models_come_from_the_cache(monkeypatch, offline):
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: True)
    monkeypatch.delenv("HF_TOKEN")
    monkeypatch.setenv("HF_HUB_OFFLINE", offline)
    assert whisperx_backend.WhisperXBackend().unavailable_reason() is None


def test_offline_mode_off_still_needs_a_token(monkeypatch):
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: True)
    monkeypatch.delenv("HF_TOKEN")
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    assert "HF_TOKEN" in whisperx_backend.WhisperXBackend().unavailable_reason()


def test_available_with_whisperx_and_a_token_without_importing_it(monkeypatch):
    monkeypatch.setattr(whisperx_backend, "whisperx_installed", lambda: True)
    monkeypatch.delitem(sys.modules, "whisperx", raising=False)
    assert whisperx_backend.WhisperXBackend().unavailable_reason() is None
    assert "whisperx" not in sys.modules


# ── loading the diarization pipeline ─────────────────────────────────────────

def test_load_builds_the_default_pipeline_with_the_token_on_cpu(monkeypatch):
    _, fake = labeller(monkeypatch)
    assert fake.pipelines == [{"model_name": None, "token": "hf_test_token", "device": "cpu"}]


def test_load_uses_cuda_when_available_unless_stt_device_is_cpu(monkeypatch):
    _, fake = labeller(monkeypatch, cuda=True)
    monkeypatch.setenv("STT_DEVICE", "cpu")
    whisperx_backend.WhisperXBackend().load()
    assert [p["device"] for p in fake.pipelines] == ["cuda", "cpu"]


def test_diarization_model_can_be_overridden(monkeypatch):
    monkeypatch.setenv("DIARIZATION_MODEL", "acme/diarizer")
    _, fake = labeller(monkeypatch)
    assert fake.pipelines[0]["model_name"] == "acme/diarizer"


def test_pyannote_telemetry_is_off_unless_the_operator_opts_in(monkeypatch):
    labeller(monkeypatch)
    assert whisperx_backend.os.environ["PYANNOTE_METRICS_ENABLED"] == "false"
    monkeypatch.setenv("PYANNOTE_METRICS_ENABLED", "true")
    labeller(monkeypatch)
    assert whisperx_backend.os.environ["PYANNOTE_METRICS_ENABLED"] == "true"


def test_load_failure_never_leaks_the_token(monkeypatch):
    fake = install(monkeypatch, FakeWhisperX())
    class Refused:
        def __init__(self, model_name=None, token=None, device="cpu", cache_dir=None):
            raise RuntimeError(f"401 Client Error: gated repo (token {token})")
    sys.modules["whisperx.diarize"].DiarizationPipeline = Refused
    with pytest.raises(RuntimeError) as err:
        whisperx_backend.WhisperXBackend().load()
    assert "401 Client Error: gated repo" in str(err.value)
    assert "hf_test_token" not in str(err.value)


# ── labelling: align (best effort) -> diarize -> assign ──────────────────────

def test_segments_are_aligned_diarized_and_assigned_with_whisperx(monkeypatch):
    label, fake = labeller(monkeypatch)
    before = copy.deepcopy(SEGMENTS)
    out = label(SEGMENTS, AUDIO, "en", 2, 3)
    assert out == [
        {"start": 0.01, "end": 0.55, "text": "hi there", "speaker": "SPEAKER_01",
         "words": [{"word": " hi", "start": 0.01, "end": 0.25, "speaker": "SPEAKER_01"},
                   {"word": " there", "start": 0.31, "end": 0.55, "speaker": "SPEAKER_01"}]},
        {"start": 2.01, "end": 2.25, "text": "hello", "speaker": "SPEAKER_00",
         "words": [{"word": " hello", "start": 2.01, "end": 2.25, "speaker": "SPEAKER_00"}]},
    ]
    assert SEGMENTS == before  # input untouched
    assert fake.diarize_calls == [(AUDIO, 2, 3)]
    assert fake.assigned[0][0] == TURNS
    assert [(t[0]["text"], model, device) for t, model, device in fake.align_calls] == [
        (" hi there", "align-model-en", "cpu"), (" hello", "align-model-en", "cpu")]


def test_align_model_is_loaded_once_per_language(monkeypatch):
    label, fake = labeller(monkeypatch, FakeWhisperX(align_load_delay=0.05))
    threads = [threading.Thread(target=lambda: label(SEGMENTS, AUDIO, "en", None, None)) for _ in range(3)]
    for t in threads: t.start()
    for t in threads: t.join()
    label(SEGMENTS, AUDIO, "ja", None, None)
    assert fake.align_loads == [("en", "cpu"), ("ja", "cpu")]


def test_language_without_an_align_model_keeps_whispers_word_timings(monkeypatch):
    label, fake = labeller(monkeypatch)
    out = label(SEGMENTS, AUDIO, "xx", None, None)
    assert fake.align_loads == [] and fake.align_calls == []
    assert [(w["word"], w["start"], w.get("speaker")) for w in out[0]["words"]] == [
        (" hi", 0.0, "SPEAKER_01"), (" there", 0.5, "SPEAKER_01")]


def test_align_model_load_failure_keeps_whisper_timings_and_is_retried_later(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(whisperx_backend, "_now", lambda: clock[0])
    label, fake = labeller(monkeypatch, FakeWhisperX(align_load_error=OSError("network down")))
    out = label(SEGMENTS, AUDIO, "en", None, None)
    assert out[1]["words"][0]["start"] == 2.0 and out[1]["speaker"] == "SPEAKER_00"
    fake.align_load_error = None
    # Remembered for a while: a hub timeout isn't paid again on every request.
    clock[0] += whisperx_backend.ALIGN_RETRY_SECONDS - 1
    out = label(SEGMENTS, AUDIO, "en", None, None)
    assert out[1]["words"][0]["start"] == 2.0
    assert len(fake.align_loads) == 1
    clock[0] += 2
    out = label(SEGMENTS, AUDIO, "en", None, None)
    assert out[1]["words"][0]["start"] == 2.01
    assert len(fake.align_loads) == 2


def test_a_failed_align_model_does_not_hold_back_other_languages(monkeypatch):
    fake = FakeWhisperX()
    real_load = fake.load_align_model
    def load(language_code, device, **kw):
        if language_code == "en":
            fake.align_loads.append((language_code, device))
            raise OSError("network down")
        return real_load(language_code, device, **kw)
    fake.load_align_model = load
    label, _ = labeller(monkeypatch, fake)
    label(SEGMENTS, AUDIO, "en", None, None)
    out = label(SEGMENTS, AUDIO, "fr", None, None)
    assert out[0]["words"][0]["start"] == 0.01  # fr aligned
    assert fake.align_loads == [("en", "cpu"), ("fr", "cpu")]


def test_at_most_two_align_models_stay_loaded(monkeypatch):
    label, fake = labeller(monkeypatch, cuda=True)
    for language in ("en", "ja", "en", "fr", "en", "ja"):
        label(SEGMENTS, AUDIO, language, None, None)
    # en is reused while recent; ja is evicted by fr, then loaded again.
    assert [lang for lang, _ in fake.align_loads] == ["en", "ja", "fr", "ja"]
    assert whisperx_backend.MAX_ALIGN_MODELS == 2
    assert fake.cache_empties  # evicting frees the GPU cache


def test_an_evicted_align_model_is_unreferenced_when_memory_is_released(monkeypatch):
    import gc
    import weakref

    class AlignModel:
        pass
    fake = FakeWhisperX()
    refs = {}
    def load(language_code, device, **kw):
        fake.align_loads.append((language_code, device))
        model = AlignModel()
        refs[language_code] = weakref.ref(model)
        return model, {"language": language_code}
    fake.load_align_model = load
    label, _ = labeller(monkeypatch, fake, cuda=True)
    alive_at_release = []
    def empty_cache():
        gc.collect()
        alive_at_release.append(refs["en"]() is not None)
    sys.modules["torch"].cuda.empty_cache = empty_cache
    monkeypatch.setattr(whisperx_backend, "_has_align_model", lambda language: True)
    # Alignment itself is not under test (and the fake would keep the model in align_calls).
    monkeypatch.setattr(whisperx_backend._Labeller, "_align_segment", lambda self, seg, model, audio: [])
    for language in ("en", "ja", "fr"):
        label(SEGMENTS, AUDIO, language, None, None)
    assert alive_at_release == [False]


# ── giving memory back ───────────────────────────────────────────────────────

def test_release_memory_empties_the_cuda_cache_when_torch_uses_cuda(monkeypatch):
    fake = install(monkeypatch, FakeWhisperX(), cuda=True)
    whisperx_backend.release_memory()
    assert fake.cache_empties == [True]


def test_release_memory_is_a_no_op_on_cpu(monkeypatch):
    fake = install(monkeypatch, FakeWhisperX(), cuda=False)
    whisperx_backend.release_memory()
    assert fake.cache_empties == []


def test_release_memory_never_imports_torch(monkeypatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    whisperx_backend.release_memory()
    assert "torch" not in sys.modules


def test_release_memory_survives_a_failing_cache_flush(monkeypatch):
    install(monkeypatch, FakeWhisperX(), cuda=True)
    def boom():
        raise RuntimeError("CUDA error: device-side assert")
    sys.modules["torch"].cuda.empty_cache = boom
    whisperx_backend.release_memory()  # logged, not raised


def test_a_segment_that_fails_to_align_keeps_its_own_words(monkeypatch):
    fails_on_hello = lambda seg: RuntimeError("backtrack failed") if "hello" in seg["text"] else None
    label, _ = labeller(monkeypatch, FakeWhisperX(align_error=fails_on_hello))
    out = label(SEGMENTS, AUDIO, "en", None, None)
    assert out[0]["words"][0]["start"] == 0.01  # aligned
    assert out[1]["words"] == [{"word": " hello", "start": 2.0, "end": 3.0, "speaker": "SPEAKER_00"}]


def test_pyannotes_torchcodec_warning_is_silenced_because_audio_arrives_decoded(monkeypatch, recwarn):
    # The image has no FFmpeg libs for torchcodec; we hand pyannote waveforms,
    # so its "audio decoding will fail" import warning would only alarm operators.
    fake = install(monkeypatch, FakeWhisperX())
    base = sys.modules["whisperx.diarize"].DiarizationPipeline
    class Warns(base):
        def __init__(self, *args, **kwargs):
            import warnings
            warnings.warn("\ntorchcodec is not installed correctly so built-in audio decoding will fail.")
            warnings.warn("an unrelated warning")
            super().__init__(*args, **kwargs)
    sys.modules["whisperx.diarize"].DiarizationPipeline = Warns
    whisperx_backend.WhisperXBackend().load()
    messages = [str(w.message) for w in recwarn]
    assert not any("torchcodec" in m for m in messages)
    assert "an unrelated warning" in messages
    assert fake.pipelines
