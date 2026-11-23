"""/transcribe's guard rails: access key, upload size, bad input, a bounded
queue, client disconnects and the memory bounds of speaker detection."""
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import server
from conftest import FakeDiarizationBackend, FakeModel, make_silent_wav, post_wav
from server import app, _state

NOT_AUDIO = "The uploaded file isn't audio this sidecar can read."
WAIT_SECONDS = 2.0


@pytest.fixture
def fake_model():
    _state.update(model=FakeModel(), model_name="small")


def wait_until(condition):
    deadline = time.monotonic() + WAIT_SECONDS
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.01)
    return condition()


def raw_multipart(filename: bytes, payload: bytes):
    boundary = b"parley-test-boundary"
    body = (b"--" + boundary + b"\r\n"
            b'Content-Disposition: form-data; name="file"; filename="' + filename + b'"\r\n'
            b"Content-Type: application/octet-stream\r\n\r\n" + payload + b"\r\n"
            b"--" + boundary + b"--\r\n")
    return body, {"content-type": "multipart/form-data; boundary=" + boundary.decode()}


# ── shared secret (STT_API_KEY) ──────────────────────────────────────────────

@pytest.fixture
def api_key(monkeypatch, fake_model):
    monkeypatch.setattr(server, "STT_API_KEY", "s3cret-key")
    return "s3cret-key"


@pytest.mark.parametrize("headers", [
    {}, {"Authorization": "Bearer wrong"}, {"Authorization": "s3cret-key"},
    {"Authorization": "Basic s3cret-key"}, {"Authorization": "Bearer s3cret-key-and-more"}])
def test_a_missing_or_wrong_key_is_refused(api_key, headers):
    r = post_wav(headers=headers)
    assert r.status_code == 401
    assert r.json() == {"detail": "Missing or wrong access key."}


@pytest.mark.parametrize("scheme", ["Bearer", "bearer"])
def test_the_right_key_is_accepted(api_key, scheme):
    r = post_wav(headers={"Authorization": f"{scheme} {api_key}"})
    assert r.status_code == 200 and r.json()["text"] == "hello world"


def test_health_stays_open_and_says_a_key_is_required_without_revealing_it(api_key):
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json()["auth"] == "key"
    assert api_key not in r.text


def test_without_a_key_nothing_is_required(fake_model):
    assert TestClient(app).get("/health").json()["auth"] == "none"
    assert post_wav().status_code == 200


# ── upload size (STT_MAX_UPLOAD_BYTES) ───────────────────────────────────────

def test_an_upload_over_the_limit_is_refused(monkeypatch, fake_model):
    monkeypatch.setattr(server, "STT_MAX_UPLOAD_BYTES", 1000)  # the wav is ~32 KB
    r = post_wav()
    assert r.status_code == 413
    assert "STT_MAX_UPLOAD_BYTES" in r.json()["detail"]


def test_a_streamed_upload_without_a_length_is_cut_off_past_the_limit(monkeypatch, fake_model):
    import request_guard
    monkeypatch.setattr(server, "STT_MAX_UPLOAD_BYTES", 1000)
    monkeypatch.setattr(request_guard, "FORM_OVERHEAD_BYTES", 0)
    body, headers = raw_multipart(b"a.wav", make_silent_wav().read())
    r = TestClient(app).post("/transcribe", content=iter([body]), headers=headers)  # chunked: no Content-Length
    assert r.status_code == 413
    assert "STT_MAX_UPLOAD_BYTES" in r.json()["detail"]


def test_an_upload_at_the_limit_is_accepted(monkeypatch, fake_model):
    monkeypatch.setattr(server, "STT_MAX_UPLOAD_BYTES", len(make_silent_wav().read()))
    assert post_wav().status_code == 200


# ── odd filenames and non-audio uploads ──────────────────────────────────────

@pytest.mark.parametrize("filename", [b"a." + b"x" * 400, b"a.wa\x00v", b"no-extension", b""])
def test_odd_filenames_are_not_a_server_error(fake_model, filename):
    body, headers = raw_multipart(filename, make_silent_wav().read())
    r = TestClient(app, raise_server_exceptions=False).post("/transcribe", content=body, headers=headers)
    assert r.status_code == 200


@pytest.mark.parametrize("payload", [b"this is not audio\n" * 100, b"\x00\x01\x02garbage" * 500, b""])
@pytest.mark.parametrize("diarize_flag", ["false", "true"])
def test_a_file_that_is_not_audio_is_a_client_error(speaker_env, payload, diarize_flag):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    r = TestClient(app, raise_server_exceptions=False).post(
        "/transcribe", files={"file": ("notes.txt", payload, "text/plain")}, data={"diarize": diarize_flag})
    assert r.status_code == 400
    assert r.json() == {"detail": NOT_AUDIO}
    assert model.inputs == [] and backend.calls == []


# ── bounded queue (STT_MAX_QUEUE) and a /health that never waits ─────────────

def test_health_runs_on_the_event_loop_not_in_a_worker_thread():
    import inspect
    assert inspect.iscoroutinefunction(server.health)


def test_requests_beyond_the_queue_are_told_the_sidecar_is_busy(monkeypatch):
    started, release = threading.Event(), threading.Event()
    class BlockingModel(FakeModel):
        def transcribe(self, audio, **kw):
            started.set()
            release.wait(WAIT_SECONDS)
            return super().transcribe(audio, **kw)
    model = BlockingModel()
    monkeypatch.setattr(server, "get_model", lambda name: model)
    monkeypatch.setattr(server, "get_batched", lambda m: None)
    monkeypatch.setattr(server, "STT_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(server, "STT_MAX_QUEUE", 0)
    first = []
    worker = threading.Thread(target=lambda: first.append(post_wav()))
    worker.start()
    try:
        assert started.wait(WAIT_SECONDS)
        busy = post_wav()
        health = TestClient(app).get("/health")
    finally:
        release.set()
        worker.join()
    assert busy.status_code == 503 and busy.json() == {"detail": "busy"}
    assert busy.headers.get("retry-after")
    assert health.status_code == 200
    assert first[0].status_code == 200
    assert post_wav().status_code == 200  # the slot is free again


# ── client disconnects ───────────────────────────────────────────────────────

@pytest.mark.parametrize("data", [{}, {"diarize": "true"}])
def test_work_for_a_client_that_has_gone_is_skipped(speaker_env, monkeypatch, data):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    monkeypatch.setattr(server, "_client_gone", lambda request: True)
    r = post_wav(data)
    assert r.status_code == 499
    assert model.inputs == [] and backend.calls == []


def test_speaker_labelling_is_skipped_when_the_client_leaves_during_transcription(speaker_env, monkeypatch):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    monkeypatch.setattr(server, "_client_gone", lambda request: bool(model.inputs))
    r = post_wav({"diarize": "true"})
    assert r.status_code == 499
    assert len(model.inputs) == 1 and backend.calls == []


def test_a_connected_client_is_never_reported_gone_by_the_real_probe(fake_model):
    assert post_wav().status_code == 200


# ── speaker detection memory bounds ──────────────────────────────────────────

def test_the_speaker_model_loads_before_waiting_for_a_transcription_slot(speaker_env, monkeypatch):
    _, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(server, "_inference_slots", slots)
    results = []
    slots.acquire()  # another transcription holds the only slot
    worker = threading.Thread(target=lambda: results.append(post_wav({"diarize": "true"})))
    worker.start()
    try:
        loaded_while_waiting = wait_until(lambda: backend.loads == 1)
    finally:
        slots.release()
        worker.join()
    assert loaded_while_waiting
    assert results[0].status_code == 200


def test_speaker_detection_decodes_one_recording_at_a_time(speaker_env, monkeypatch):
    _, with_backend = speaker_env
    with_backend(FakeDiarizationBackend())
    monkeypatch.setattr(server, "_inference_slots", threading.BoundedSemaphore(2))
    running, peak, lock = [0], [0], threading.Lock()
    real_decode = server.decode_audio
    def tracked_decode(*args, **kwargs):
        with lock:
            running[0] += 1; peak[0] = max(peak[0], running[0])
        time.sleep(0.1)
        with lock:
            running[0] -= 1
        return real_decode(*args, **kwargs)
    monkeypatch.setattr(server, "decode_audio", tracked_decode)
    statuses = []
    workers = [threading.Thread(target=lambda: statuses.append(post_wav({"diarize": "true"}).status_code))
               for _ in range(3)]
    for t in workers: t.start()
    for t in workers: t.join()
    assert statuses == [200, 200, 200]
    assert peak[0] == 1


def test_a_recording_longer_than_the_speaker_detection_limit_is_refused(speaker_env, monkeypatch):
    model, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend())
    monkeypatch.setattr(server, "STT_MAX_DIARIZE_SECONDS", 0.5)  # the wav is 1 s
    r = post_wav({"diarize": "true"})
    assert r.status_code == 400
    assert r.json()["detail"].startswith(
        "Recording is longer than this sidecar accepts for speaker detection (")
    assert "STT_MAX_DIARIZE_SECONDS" in r.json()["detail"]
    assert model.inputs == [] and backend.calls == []


def test_the_speaker_detection_limit_leaves_plain_transcription_alone(speaker_env, monkeypatch):
    model, _ = speaker_env
    monkeypatch.setattr(server, "STT_MAX_DIARIZE_SECONDS", 0.5)
    assert post_wav().status_code == 200
    assert len(model.inputs) == 1


def test_a_recording_within_the_speaker_detection_limit_is_labelled(speaker_env, monkeypatch):
    _, with_backend = speaker_env
    backend = with_backend(FakeDiarizationBackend(turns=[(0.0, 3.0, "SPEAKER_00")]))
    monkeypatch.setattr(server, "STT_MAX_DIARIZE_SECONDS", 1)
    r = post_wav({"diarize": "true"})
    assert r.status_code == 200 and r.json()["speakers"] == ["SPEAKER_00"]
    assert isinstance(backend.calls[0][1], np.ndarray)
