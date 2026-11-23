from fastapi.testclient import TestClient
from server import app, _state
from conftest import FakeModel, make_silent_wav, reset_state

def test_health():
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"

def test_transcribe_returns_text(monkeypatch):
    _state["model"] = FakeModel()
    _state["model_name"] = "small"  # match the default so get_model() reuses the fake, never builds a real model
    client = TestClient(app)
    wav = make_silent_wav()
    r = client.post("/transcribe", files={"file": ("a.wav", wav, "audio/wav")})
    body = r.json()
    assert body["text"] == "hello world"
    assert body["words"][0]["word"] == "hello"

def test_cuda_preload_skips_nvblas_which_would_hijack_cpu_blas(monkeypatch):
    # libnvblas (shipped in nvidia-cublas-cu12) interposes the BLAS symbols of
    # every library once loaded RTLD_GLOBAL; without an nvblas.conf, torch's
    # CPU matmuls (speaker detection) then segfault. ctranslate2 never needs it.
    import server
    libs = ["/sp/nvidia/cublas/lib/libcublas.so.12", "/sp/nvidia/cublas/lib/libnvblas.so.12",
            "/sp/nvidia/cudnn/lib/libcudnn.so.9"]
    loaded = []
    monkeypatch.setattr(server.glob, "glob", lambda pattern: list(libs))
    monkeypatch.setattr(server.ctypes, "CDLL", lambda path, mode=0: loaded.append(path))
    server._preload_cuda_libs()
    assert loaded == [libs[0], libs[2]]


def test_auto_falls_back_to_cpu_when_cuda_fails(monkeypatch):
    reset_state()
    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append((device, compute_type))
        if device == "cuda":
            raise RuntimeError("no CUDA runtime")
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    assert attempts == [("cuda", "float16"), ("cpu", "int8")]
    assert _state["device"] == "cpu" and _state["compute"] == "int8"

def test_working_device_is_cached_across_rebuilds(monkeypatch):
    reset_state()
    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append(device)
        if device == "cuda":
            raise RuntimeError("no CUDA runtime")
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    server.get_model("large")  # model-name change forces a rebuild
    assert attempts == ["cuda", "cpu", "cpu"]  # cuda tried exactly once

def test_health_reports_device_and_compute(monkeypatch):
    reset_state()
    monkeypatch.setattr("server.WhisperModel", lambda name, device, compute_type: FakeModel())
    import server
    server.get_model("small")
    body = TestClient(app).get("/health").json()
    assert body["device"] == "cuda" and body["compute"] == "float16"

def test_warmup_inference_failure_falls_back_to_cpu(monkeypatch):
    # Model construction can succeed on a broken cuda runtime (e.g. pip nvidia
    # libs missing from the loader path); the failure only surfaces on the
    # first real inference. get_model's warm-up call must catch that and fall
    # back to cpu instead of leaving a broken cuda model cached.
    reset_state()

    class BrokenCudaModel:
        def __init__(self, device):
            self.device = device
        def transcribe(self, audio, **kwargs):
            if self.device == "cuda":
                raise RuntimeError("Library libcublas.so.12 is not found or cannot be loaded")
            return [], type("I", (), {"language": "en"})()

    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append((device, compute_type))
        return BrokenCudaModel(device)
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    assert attempts == [("cuda", "float16"), ("cpu", "int8")]
    assert _state["device"] == "cpu" and _state["compute"] == "int8"

def test_transcribe_rebuilds_model_on_name_change(monkeypatch):
    # A model is warm under a different name; a request for "small" must rebuild.
    _state["model"] = FakeModel()
    _state["model_name"] = "large"
    built = {}
    def fake_ctor(name, **kwargs):
        built["name"] = name
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    client = TestClient(app)
    r = client.post("/transcribe",
                    files={"file": ("a.wav", make_silent_wav(), "audio/wav")},
                    data={"model": "small"})
    assert r.status_code == 200
    assert built["name"] == "small"  # rebuilt with the requested model, not stale "large"


def test_health_reports_batch_size(monkeypatch):
    reset_state()
    monkeypatch.setattr("server.WhisperModel", lambda name, device, compute_type: FakeModel())
    import server
    server.get_model("small")  # device becomes 'cuda' (fake ctor never raises)
    body = TestClient(app).get("/health").json()
    assert "batch_size" in body
    assert body["batch_size"] == 8  # cuda default


def test_batch_size_disabled_uses_sequential(monkeypatch):
    # STT_BATCH_SIZE=0 disables batching; a FakeModel (no feature_extractor)
    # would also force the sequential path. Either way transcribe still works.
    reset_state()
    monkeypatch.setattr("server.STT_BATCH_SIZE", 0)
    _state["model"] = FakeModel()
    _state["model_name"] = "small"
    import server
    assert server.get_batched(_state["model"]) is None  # disabled
    r = TestClient(app).post("/transcribe",
                             files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
    assert r.json()["text"] == "hello world"


def test_fake_model_falls_back_to_sequential(monkeypatch):
    # A model without feature_extractor (the test fake) must not be wrapped in the
    # batched pipeline — get_batched returns None so transcribe stays sequential.
    reset_state()
    monkeypatch.setattr("server.STT_BATCH_SIZE", None)  # per-device default (>0)
    _state.update(model=FakeModel(), model_name="small", device="cpu", compute="int8")
    import server
    assert server.get_batched(_state["model"]) is None


def test_vocabulary_reaches_sequential_and_batched_transcription(monkeypatch):
    import server
    for batched in (False, True):
        calls = []
        class CapturingModel(FakeModel):
            def transcribe(self, path, **kwargs):
                calls.append(kwargs)
                return super().transcribe(path, **kwargs)
        model = CapturingModel()
        monkeypatch.setattr(server, "get_model", lambda name: model)
        monkeypatch.setattr(server, "get_batched", lambda m: m if batched else None)
        r = TestClient(app).post("/transcribe",
                                files={"file": ("a.wav", make_silent_wav(), "audio/wav")},
                                data={"vocabulary": "AWP, connector"})
        assert r.status_code == 200
        assert calls[0]["hotwords"] == "AWP, connector"
        calls.clear()
        r = TestClient(app).post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
        assert r.status_code == 200
        assert "hotwords" not in calls[0]


# ── concurrency, cleanup and input validation ────────────────────────────────
import threading, time, tempfile, os


def test_concurrent_cold_requests_build_the_model_once(monkeypatch):
    reset_state()
    built = []
    def slow_ctor(name, device, compute_type):
        built.append(name)
        time.sleep(0.2)  # a real load takes seconds; requests pile up meanwhile
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", slow_ctor)
    import server
    models = []
    threads = [threading.Thread(target=lambda: models.append(server.get_model("small"))) for _ in range(4)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert built == ["small"]
    assert len({id(m) for m in models}) == 1


def test_batched_pipeline_wraps_the_model_this_request_got(monkeypatch):
    import server
    class RealishModel(FakeModel):
        feature_extractor = object()
    mine, other = RealishModel(), RealishModel()
    _state.update(model=other, model_name="large", batched=None)  # another guild's model is warm
    wrapped = []
    class FakePipeline:
        def __init__(self, model): wrapped.append(model); self.model = model
        def transcribe(self, path, **kw): return self.model.transcribe(path, **kw)
    monkeypatch.setattr(server, "BatchedInferencePipeline", FakePipeline)
    monkeypatch.setattr(server, "STT_BATCH_SIZE", 4)
    monkeypatch.setattr(server, "get_model", lambda name: mine)
    r = TestClient(app).post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
    assert r.status_code == 200
    assert wrapped == [mine]


def test_inference_is_capped_by_the_concurrency_limit(monkeypatch):
    import server
    running, peak, lock = [0], [0], threading.Lock()
    class SlowModel(FakeModel):
        def transcribe(self, path, **kw):
            with lock:
                running[0] += 1; peak[0] = max(peak[0], running[0])
            time.sleep(0.1)
            with lock:
                running[0] -= 1
            return super().transcribe(path, **kw)
    model = SlowModel()
    monkeypatch.setattr(server, "get_model", lambda name: model)
    monkeypatch.setattr(server, "get_batched", lambda m: None)
    monkeypatch.setattr(server, "_inference_slots", threading.BoundedSemaphore(1))
    client = TestClient(app)
    def call():
        assert client.post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")}).status_code == 200
    threads = [threading.Thread(target=call) for _ in range(3)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert peak[0] == 1


def stt_temp_files():
    return {f for f in os.listdir(tempfile.gettempdir()) if f.startswith("stt-")}


def test_upload_is_decoded_from_the_received_file_without_a_second_copy(monkeypatch):
    # The multipart parser already spooled the upload to disk; copying it to a
    # second temp file stored every recording twice.
    before = stt_temp_files()
    def no_second_copy(*a, **kw): raise AssertionError("the upload was copied to another file")
    monkeypatch.setattr(tempfile, "mkstemp", no_second_copy)
    _state.update(model=FakeModel(), model_name="small")
    r = TestClient(app).post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
    assert r.status_code == 200
    assert stt_temp_files() == before


def test_invalid_model_or_language_is_a_client_error(monkeypatch):
    import server
    loads = []
    monkeypatch.setattr(server, "get_model", lambda name: loads.append(name) or FakeModel())
    client = TestClient(app)
    wav = lambda: {"file": ("a.wav", make_silent_wav(), "audio/wav")}
    r = client.post("/transcribe", files=wav(), data={"model": "../../etc/passwd"})
    assert r.status_code == 400 and "model" in r.json()["detail"].lower()
    r = client.post("/transcribe", files=wav(), data={"language": "klingon"})
    assert r.status_code == 400 and "language" in r.json()["detail"].lower()
    assert loads == []  # rejected before any model is loaded or downloaded
    class EnglishOnly(FakeModel):
        supported_languages = ["en"]
    monkeypatch.setattr(server, "get_model", lambda name: EnglishOnly())
    r = client.post("/transcribe", files=wav(), data={"model": "small.en", "language": "de"})
    assert r.status_code == 400
    assert client.post("/transcribe", files=wav(), data={"model": "small.en", "language": "en"}).status_code == 200

def test_transcribe_returns_sentence_segments(monkeypatch):
    # Segments are the transcript lines the dashboard can seek the recording to.
    _state["model"] = FakeModel()
    _state["model_name"] = "small"
    client = TestClient(app)
    r = client.post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
    assert r.json()["segments"] == [{"start": 0.0, "end": 1.0, "text": "hello world"}]


# ── speaker detection (diarize=true) ─────────────────────────────────────────
import numpy as np
import pytest
import diarize

DIARIZE_PREFIX = "Speaker detection is not enabled on this sidecar: "


from conftest import FakeDiarizationBackend, post_wav  # noqa: E402


def test_health_reports_whether_speaker_detection_is_available(speaker_env):
    _, with_backend = speaker_env
    with_backend(FakeDiarizationBackend(reason="HF_TOKEN is not set"))
    body = TestClient(app).get("/health").json()
    assert body["diarization"] == {"available": False, "reason": "HF_TOKEN is not set"}
    backend = with_backend(FakeDiarizationBackend())
    assert TestClient(app).get("/health").json()["diarization"] == {"available": True, "reason": None}
    assert backend.loads == 0  # /health stays cheap


def test_default_sidecar_reports_speaker_detection_unavailable():
    # No whisperx in the default image (nor in CI), and no HF_TOKEN in either
    # image by default: /health says why, it doesn't fail.
    body = TestClient(app).get("/health").json()
    assert body["diarization"]["available"] is False
    assert body["diarization"]["reason"]


@pytest.mark.parametrize("data", [{}, {"diarize": "false"}])
def test_without_diarize_the_response_is_unchanged(speaker_env, data):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend(turns=[(0.0, 3.0, "SPEAKER_00")]))
    r = post_wav(data)
    assert r.status_code == 200
    assert r.json() == {
        "text": "hi there hello",
        "words": [{"word": " hi", "start": 0.0, "end": 0.4}, {"word": " there", "start": 0.5, "end": 1.0},
                  {"word": " hello", "start": 2.0, "end": 3.0}],
        "segments": [{"start": 0.0, "end": 1.0, "text": "hi there"}, {"start": 2.0, "end": 3.0, "text": "hello"}],
        "language": "en"}
    # Decoded to 16 kHz mono up front (faster-whisper would decode the file the same way).
    assert isinstance(model.inputs[0], np.ndarray) and model.inputs[0].shape == (16000,)
    assert backend.loads == 0 and backend.calls == []


def test_diarize_labels_words_and_segments_and_lists_speakers(speaker_env):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend(
        turns=[(0.0, 1.1, "SPEAKER_01"), (1.9, 3.0, "SPEAKER_00")]))
    r = post_wav({"diarize": "true"})
    assert r.status_code == 200
    body = r.json()
    assert [(w["word"], w["speaker"]) for w in body["words"]] == [
        (" hi", "SPEAKER_01"), (" there", "SPEAKER_01"), (" hello", "SPEAKER_00")]
    assert body["segments"] == [
        {"start": 0.0, "end": 1.0, "text": "hi there", "speaker": "SPEAKER_01"},
        {"start": 2.0, "end": 3.0, "text": "hello", "speaker": "SPEAKER_00"}]
    assert body["speakers"] == ["SPEAKER_01", "SPEAKER_00"]  # order of first appearance
    assert body["text"] == "hi there hello" and body["language"] == "en"
    # Decoded once to 16 kHz mono: Whisper and WhisperX get the same samples,
    # plus Whisper's nested segments and detected language.
    segments, audio, language, _, _ = backend.calls[0]
    assert isinstance(audio, np.ndarray) and audio.dtype == np.float32 and audio.shape == (16000,)
    assert model.inputs[0] is audio
    assert language == "en"
    assert segments[0] == {"start": 0.0, "end": 1.0, "text": " hi there",
                           "words": [{"word": " hi", "start": 0.0, "end": 0.4},
                                     {"word": " there", "start": 0.5, "end": 1.0}]}


def test_words_and_segments_without_a_speaker_get_null(speaker_env):
    _, with_backend = speaker_env
    with_backend(FakeDiarizationBackend(turns=[(0.0, 0.9, "SPEAKER_00")]))
    body = post_wav({"diarize": "true"}).json()
    assert [w["speaker"] for w in body["words"]] == ["SPEAKER_00", "SPEAKER_00", None]
    assert body["segments"][1]["speaker"] is None
    assert body["speakers"] == ["SPEAKER_00"]


def test_speaker_count_bounds_reach_the_backend(speaker_env):
    _, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    assert post_wav({"diarize": "true", "min_speakers": "2", "max_speakers": "3"}).status_code == 200
    assert post_wav({"diarize": "true", "max_speakers": "4"}).status_code == 200
    assert [(lo, hi) for *_, lo, hi in backend.calls] == [(2, 3), (None, 4)]


@pytest.mark.parametrize("data", [
    {"min_speakers": "0"}, {"max_speakers": "21"}, {"min_speakers": "4", "max_speakers": "2"}])
def test_invalid_speaker_count_bounds_are_a_client_error(speaker_env, data):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    r = post_wav({"diarize": "true", **data})
    assert r.status_code == 400
    assert "speakers" in r.json()["detail"]
    assert model.inputs == [] and backend.loads == 0


def test_diarize_when_unavailable_is_a_400_before_any_transcription(speaker_env):
    model, with_backend = speaker_env
    with_backend(FakeDiarizationBackend(reason="HF_TOKEN is not set"))
    r = post_wav({"diarize": "true"})
    assert r.status_code == 400
    assert r.json()["detail"] == DIARIZE_PREFIX + "HF_TOKEN is not set"
    assert model.inputs == []


def test_diarization_model_load_failure_is_a_400(speaker_env):
    model, with_backend = speaker_env
    with_backend(FakeDiarizationBackend(load_error=RuntimeError("terms not accepted")))
    r = post_wav({"diarize": "true"})
    assert r.status_code == 400
    assert r.json()["detail"].startswith(DIARIZE_PREFIX)
    assert "terms not accepted" in r.json()["detail"]
    assert model.inputs == []  # the model load is checked before transcribing
    assert "terms not accepted" in TestClient(app).get("/health").json()["diarization"]["reason"]


# ── model cache and /health accuracy ─────────────────────────────────────────
import gc
import weakref


class RealishModel(FakeModel):
    feature_extractor = object()  # what BatchedInferencePipeline needs


def test_a_batched_pipeline_for_a_swapped_out_model_is_not_cached(monkeypatch):
    # Caching it would pin the old model (and its GPU memory) next to the new one.
    import server
    current, stale = RealishModel(), RealishModel()
    _state.update(model=current, model_name="small", batched=None, batched_for=None)
    monkeypatch.setattr(server, "BatchedInferencePipeline", lambda model: ("pipeline", model))
    monkeypatch.setattr(server, "STT_BATCH_SIZE", 4)
    assert server.get_batched(stale) == ("pipeline", stale)
    assert _state["batched"] is None and _state["batched_for"] is None
    assert server.get_batched(current) == ("pipeline", current)
    assert _state["batched_for"] is current


def test_a_model_swap_lets_go_of_the_old_model_before_building_the_new_one(monkeypatch):
    import server
    reset_state()
    old = FakeModel()
    old_ref = weakref.ref(old)
    _state.update(model=old, model_name="large", device="cpu", compute="int8")
    del old
    alive_during_build = []
    def ctor(name, device, compute_type):
        gc.collect()
        alive_during_build.append(old_ref() is not None)
        return FakeModel()
    monkeypatch.setattr(server, "WhisperModel", ctor)
    server.get_model("small")
    assert alive_during_build == [False]
    assert _state["model_name"] == "small"


def test_health_batch_size_is_unknown_until_the_device_is(monkeypatch):
    import server
    reset_state()
    monkeypatch.setattr(server, "STT_BATCH_SIZE", None)
    monkeypatch.setattr(server, "STT_DEVICE", "auto")
    assert TestClient(app).get("/health").json()["batch_size"] is None
    monkeypatch.setattr(server, "STT_DEVICE", "cpu")
    assert TestClient(app).get("/health").json()["batch_size"] == 4


def test_health_reports_sequential_when_the_batched_pipeline_is_unavailable(monkeypatch):
    import server
    model = RealishModel()
    reset_state()
    _state.update(model=model, model_name="small", device="cuda", compute="float16")
    builds = []
    def unsupported(model):
        builds.append(model)
        raise RuntimeError("unsupported")
    monkeypatch.setattr(server, "BatchedInferencePipeline", unsupported)
    monkeypatch.setattr(server, "STT_BATCH_SIZE", None)
    assert server.get_batched(model) is None
    assert server.get_batched(model) is None
    assert builds == [model]  # not rebuilt (and re-logged) on every request
    assert TestClient(app).get("/health").json()["batch_size"] == 0
