import ctypes, glob, logging, os, re, sysconfig, threading, time
from dataclasses import dataclass
from typing import Annotated, BinaryIO, Optional

import anyio.from_thread
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request

import diarize as diarization
from request_guard import GuardLimits, RequestGuard, too_large_detail
from speaker_transcript import build_response

log = logging.getLogger("stt_sidecar")


def _env_int(name: str, default: int, minimum: int) -> int:
    """A whole-number setting; unset or unreadable means `default`, too small is raised to `minimum`."""
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not a whole number; using %d", name, raw, default)
        return default
    if value < minimum:
        log.warning("%s=%d is below %d; using %d", name, value, minimum, minimum)
    return max(minimum, value)


# Device selection (audit B2): STT_DEVICE=auto tries cuda/float16 first and falls
# back to cpu/int8 on any init failure. Explicit values are used as-is.
STT_DEVICE = os.environ.get("STT_DEVICE", "auto")
STT_COMPUTE = os.environ.get("STT_COMPUTE", "auto")
# Batched inference (faster-whisper 1.1+) transcribes a clip's VAD segments in
# parallel instead of one 30s window at a time — 1.7-2.6x faster on both GPU and
# CPU with near-identical accuracy (see docs/stt-research-2026-07-06.md). Batch
# size defaults per device; STT_BATCH_SIZE overrides, STT_BATCH_SIZE=0 disables.
_env_batch = os.environ.get("STT_BATCH_SIZE")
STT_BATCH_SIZE = int(_env_batch) if (_env_batch not in (None, "")) else None
GPU_BATCH_SIZE, CPU_BATCH_SIZE = 8, 4
# Transcriptions running at once. FastAPI's threadpool would otherwise run ~40
# in parallel on one CPU/GPU: no faster overall, but each holds its audio and
# decoder state (and possibly a different model), which can exhaust memory.
STT_MAX_CONCURRENCY = _env_int("STT_MAX_CONCURRENCY", 2, minimum=1)
# Requests allowed to wait (uploading or queued) beyond the running ones; more
# get an immediate 503 "busy" instead of tying up a worker thread each.
STT_MAX_QUEUE = _env_int("STT_MAX_QUEUE", 8, minimum=0)
# Largest accepted upload: 2 GiB, the bot's own IMPORT_MAX_BYTES default.
STT_MAX_UPLOAD_BYTES = _env_int("STT_MAX_UPLOAD_BYTES", 2 * 1024 ** 3, minimum=1)
# Longest recording speaker detection takes: its decoded audio (~0.23 GB per
# hour as float32) and the labelling models' working memory grow with length.
STT_MAX_DIARIZE_SECONDS = _env_int("STT_MAX_DIARIZE_SECONDS", 6 * 3600, minimum=1)
# Optional shared secret: when set, every endpoint but /health needs
# "Authorization: Bearer <STT_API_KEY>" (see request_guard.py).
STT_API_KEY = os.environ.get("STT_API_KEY", "").strip()
# How often a running transcription asks whether its client is still there.
DISCONNECT_POLL_SECONDS = 2.0
CLIENT_CLOSED_REQUEST = 499  # nginx's convention; the client never reads it


def _preload_cuda_libs():
    """Load pip-installed NVIDIA runtime libs (cublas/cudnn/cuda_nvrtc/...) into
    the process before ctranslate2 dlopen()s them at inference time.

    The `nvidia-*-cu12` wheels ship their .so files under
    site-packages/nvidia/<pkg>/lib/ instead of on the system loader path, so a
    fresh model *loads* fine on cuda but the first inference call fails with
    'Library libcublas.so.12 is not found or cannot be loaded'. Preloading them
    with RTLD_GLOBAL makes them visible to ctranslate2's later dlopen calls
    without needing LD_LIBRARY_PATH set externally.
    """
    purelib = sysconfig.get_paths()["purelib"]
    pattern = os.path.join(purelib, "nvidia", "*", "lib", "*.so*")
    for path in glob.glob(pattern):
        # libnvblas (in nvidia-cublas-cu12) would interpose every library's
        # BLAS calls once global; without an nvblas.conf that segfaults torch's
        # CPU matmuls (speaker detection). ctranslate2 never uses it.
        if os.path.basename(path).startswith("libnvblas"):
            continue
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
        except OSError as err:
            log.debug("Could not preload %s (%s); ignoring", path, err)


if STT_DEVICE in ("auto", "cuda"):
    _preload_cuda_libs()

from faster_whisper import WhisperModel, BatchedInferencePipeline, available_models, decode_audio  # noqa: E402 (must follow lib preload above)


def _guard_limits() -> GuardLimits:
    """Read per request, so the module settings above stay the single source."""
    return GuardLimits(api_key=STT_API_KEY, max_upload_bytes=STT_MAX_UPLOAD_BYTES,
                       max_in_flight=STT_MAX_CONCURRENCY + STT_MAX_QUEUE)


app = FastAPI()
app.add_middleware(RequestGuard, limits=_guard_limits)
_state = {"model": None, "model_name": None, "device": None, "compute": None, "batched": None, "batched_for": None}
# One model load/swap at a time: concurrent cold requests used to each build a
# WhisperModel (2x RAM or more) and race on _state.
_model_lock = threading.Lock()
_inference_slots = threading.BoundedSemaphore(STT_MAX_CONCURRENCY)
# One speaker-detection request at a time, from decoding to labelling, so two
# long recordings are never decoded (or labelled) side by side. Always taken
# before an inference slot.
_labelling_slot = threading.Lock()
# Only faster-whisper's own model names: anything else would be fetched from
# the Hugging Face Hub (or opened as a local path) on the client's say-so.
KNOWN_MODELS = frozenset(available_models())
_LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}$")
# Whisper's (and the diarizer's) input rate: uploads are decoded once to
# 16 kHz mono and the same samples go to every stage.
SAMPLE_RATE = 16000
MIN_SPEAKERS, MAX_SPEAKERS = 1, 20
DIARIZATION_UNAVAILABLE = "Speaker detection is not enabled on this sidecar: "
NOT_AUDIO = "The uploaded file isn't audio this sidecar can read."


@dataclass(frozen=True)
class WhisperOptions:
    model: str
    language: str
    vocabulary: str


class ClientDisconnected(Exception):
    """The client hung up; the rest of its transcription is skipped."""


def _resolve_batch_size() -> Optional[int]:
    """Batch size for the current device: explicit env wins (0 = disabled);
    else the per-device default (GPU holds a bigger batch than CPU). None while
    the device is undecided (STT_DEVICE=auto before the first model load)."""
    if STT_BATCH_SIZE is not None:
        return max(0, STT_BATCH_SIZE)
    device = _state["device"] or (None if STT_DEVICE == "auto" else STT_DEVICE)
    if device is None:
        return None
    return GPU_BATCH_SIZE if device == "cuda" else CPU_BATCH_SIZE


def _batching_failed() -> bool:
    """The warm model could not be wrapped in a batched pipeline (remembered until it changes)."""
    wrapped = _state["batched_for"]
    return wrapped is not None and wrapped is _state["model"] and _state["batched"] is None


def _effective_batch_size() -> Optional[int]:
    """What /health reports: the batch size the next transcription uses; 0 = sequential."""
    return 0 if _batching_failed() else _resolve_batch_size()


def _candidates():
    """Ordered (device, compute_type) pairs to try when building a model."""
    if _state["device"] is not None:
        # A device already worked once; don't retry cuda on every model rebuild.
        return [(_state["device"], _state["compute"])]
    if STT_DEVICE != "auto":
        compute = STT_COMPUTE if STT_COMPUTE != "auto" else "default"
        return [(STT_DEVICE, compute)]
    return [
        ("cuda", STT_COMPUTE if STT_COMPUTE != "auto" else "float16"),
        ("cpu", STT_COMPUTE if STT_COMPUTE != "auto" else "int8"),
    ]

def get_model(name: str):
    with _model_lock:
        if _state["model"] is not None and _state["model_name"] == name:
            return _state["model"]  # warm: rebuilds only when the requested model name changes
        return _load_model(name)


def _load_model(name: str):
    """Build the model on the first device that works (caller holds _model_lock).

    Exactly one model stays warm, so memory is predictable. The cache lets go
    of the old model before building the new one; a request still transcribing
    with the old model keeps it alive until it finishes, so a swap can briefly
    hold two, and requests alternating between two sizes reload on each switch.
    An LRU of two would avoid the reloads only by keeping two models resident
    all the time; operators who mix sizes can pin one per-guild model instead.
    """
    _state.update(model=None, model_name=None, batched=None, batched_for=None)
    candidates = _candidates()
    last_err = None
    for device, compute in candidates:
        try:
            model = WhisperModel(name, device=device, compute_type=compute)
            # Model *construction* can succeed on cuda even when the runtime is
            # broken (e.g. pip nvidia libs not on the loader path): ctranslate2
            # only dlopen()s cublas/cudnn lazily on the first inference call.
            # Do a throwaway inference here so a broken cuda runtime falls back
            # to cpu instead of 500ing every real /transcribe request.
            if device != "cpu":
                warmup_segments, _ = model.transcribe(np.zeros(1600, dtype=np.float32))
                list(warmup_segments)  # transcribe() is lazy; force real inference now
        except Exception as err:  # e.g. no CUDA runtime / missing cuDNN — fall back
            last_err = err
            log.warning("STT device %s/%s unavailable (%s); falling back", device, compute, err)
            continue
        _state.update(model=model, model_name=name, device=device, compute=compute, batched=None, batched_for=None)
        if device != "cpu":
            log.info("STT model %s running on %s/%s", name, device, compute)
        return model
    raise last_err


def get_batched(model):
    """Wrap `model` (the one this request got) in a BatchedInferencePipeline,
    cached until the model changes. Returns None if batching is disabled or the
    model can't be wrapped (e.g. a fake test model), so the caller falls back
    to sequential."""
    if not _resolve_batch_size():
        return None
    # A real faster-whisper model exposes feature_extractor; the batched pipeline
    # needs it. Guard so fakes/unsupported models fall back cleanly instead of
    # raising deep inside transcribe().
    if not hasattr(model, "feature_extractor"):
        return None
    with _model_lock:
        if _state["batched_for"] is model:
            return _state["batched"]  # None: this model can't be batched (remembered)
        try:
            batched = BatchedInferencePipeline(model=model)
        except Exception as err:  # unsupported — fall back
            log.warning("Batched pipeline unavailable (%s); using sequential", err)
            batched = None
        # Cache only for the model that is still warm: a pipeline for a
        # swapped-out model would keep it (and its memory) alive next to the new one.
        if _state["model"] is model:
            _state.update(batched=batched, batched_for=model)
        return batched


# async: answered on the event loop, so /health never waits for a worker thread
# behind queued transcriptions. Nothing in here blocks or loads a model.
@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": _state["model_name"],
        "device": _state["device"],
        "compute": _state["compute"],
        "batch_size": _effective_batch_size(),
        "auth": "key" if STT_API_KEY else "none",
        "diarization": diarization.status(),
    }

def _validate(model: str, language: str):
    """Reject bad input with a 400 before anything is loaded or downloaded, so
    the client fails fast instead of retrying a request that cannot succeed."""
    if model not in KNOWN_MODELS:
        raise HTTPException(400, f"Unsupported model {model!r}. Use one of: {', '.join(sorted(KNOWN_MODELS))}.")
    if language != "auto" and not _LANGUAGE_CODE.match(language):
        raise HTTPException(400, f"Unsupported language {language!r}: use 'auto' or an ISO 639-1 code such as 'en'.")


def _validate_speakers(min_speakers: Optional[int], max_speakers: Optional[int]) -> None:
    for name, value in (("min_speakers", min_speakers), ("max_speakers", max_speakers)):
        if value is not None and not MIN_SPEAKERS <= value <= MAX_SPEAKERS:
            raise HTTPException(400, f"{name} must be between {MIN_SPEAKERS} and {MAX_SPEAKERS}.")
    if min_speakers is not None and max_speakers is not None and min_speakers > max_speakers:
        raise HTTPException(400, "min_speakers cannot be greater than max_speakers.")


def _validate_upload_size(upload: UploadFile) -> None:
    """The exact file size (the request guard already capped the whole body)."""
    if (upload.size or 0) > STT_MAX_UPLOAD_BYTES:
        raise HTTPException(413, too_large_detail(STT_MAX_UPLOAD_BYTES))


def _client_gone(request: Request) -> bool:
    """Ask the event loop whether the client has disconnected (we run in FastAPI's worker thread)."""
    try:
        return anyio.from_thread.run(request.is_disconnected)
    except RuntimeError:  # not in an AnyIO worker thread: there is no loop to ask
        return False


class DisconnectWatch:
    """Stops work for a client that has hung up (e.g. the bot timed out).

    /transcribe is a sync handler: FastAPI runs it in a worker thread, where
    nothing can interrupt it. So it asks between stages and between Whisper
    segments; a stage already running (decoding, one batch of segments,
    speaker labelling) still runs to its end.
    """

    def __init__(self, request: Request) -> None:
        self._request = request
        self._next_poll = 0.0

    def check(self) -> None:
        if _client_gone(self._request):
            raise ClientDisconnected()

    def poll(self) -> None:
        """check(), at most once per DISCONNECT_POLL_SECONDS (for per-segment loops)."""
        now = time.monotonic()
        if now >= self._next_poll:
            self._next_poll = now + DISCONNECT_POLL_SECONDS
            self.check()


def _decode_upload(upload: BinaryIO) -> np.ndarray:
    """The upload as 16 kHz mono float32 samples, exactly as faster-whisper
    would decode it, read straight from the multipart parser's spooled file
    (no second copy on disk). The spooled file is closed right after, so a long
    transcription doesn't keep the upload on disk."""
    try:
        upload.seek(0)
        return decode_audio(upload, sampling_rate=SAMPLE_RATE)
    except MemoryError:
        raise
    except Exception as err:  # FFmpeg can't read it, no audio stream (IndexError), empty file...
        log.info("Refused an upload that could not be decoded (%s: %s)", type(err).__name__, err)
        raise HTTPException(400, NOT_AUDIO) from err
    finally:
        upload.close()


def _segment_dict(seg) -> dict:
    return {"start": seg.start, "end": seg.end, "text": seg.text,
            "words": [{"word": w.word, "start": w.start, "end": w.end}
                      for w in (getattr(seg, "words", None) or [])]}


def _whisper_segments(audio: np.ndarray, opts: WhisperOptions, watch: DisconnectWatch) -> tuple[list[dict], str]:
    """Transcribe 16 kHz mono `audio` into nested segments
    [{start, end, text, words: [{word, start, end}]}] plus the (detected) language."""
    m = get_model(opts.model)
    lang = None if opts.language == "auto" else opts.language
    supported = getattr(m, "supported_languages", None)
    if lang and supported and lang not in supported:
        raise HTTPException(400, f"Model {opts.model!r} does not support language {lang!r}.")
    hints = {"hotwords": opts.vocabulary.strip()} if opts.vocabulary.strip() else {}
    # Prefer the batched pipeline (parallel VAD segments, 1.7-2.6x faster);
    # fall back to the plain model when batching is off/unavailable.
    batched = get_batched(m)
    if batched is not None:
        segments, info = batched.transcribe(
            audio, language=lang, word_timestamps=True, batch_size=_resolve_batch_size(), **hints)
    else:
        segments, info = m.transcribe(audio, language=lang, word_timestamps=True, **hints)
    nested = []
    for seg in segments:  # lazy: the actual inference runs while iterating
        watch.poll()
        nested.append(_segment_dict(seg))
    return nested, getattr(info, "language", opts.language)


def _refuse_long_recording(audio: np.ndarray) -> None:
    seconds = audio.size / SAMPLE_RATE
    if seconds > STT_MAX_DIARIZE_SECONDS:
        raise HTTPException(400, (
            "Recording is longer than this sidecar accepts for speaker detection "
            f"({seconds / 3600:.1f} h; the limit is {STT_MAX_DIARIZE_SECONDS / 3600:.1f} h, "
            "set by STT_MAX_DIARIZE_SECONDS)."))


def _transcribe_plain(upload: BinaryIO, opts: WhisperOptions, watch: DisconnectWatch) -> dict:
    with _inference_slots:
        watch.check()
        audio = _decode_upload(upload)
        return build_response(*_whisper_segments(audio, opts, watch))


def _transcribe_with_speakers(upload: BinaryIO, opts: WhisperOptions, watch: DisconnectWatch,
                              speaker_bounds: tuple[Optional[int], Optional[int]]) -> dict:
    """WhisperX-style: faster-whisper transcript, then alignment + speakers."""
    # The speaker model (GB-scale, may download) loads before taking any slot,
    # so a slow first load never holds one; it also refuses with a 400 early.
    diarization.get_labeller()
    # Decode only once this request may label: a waiting request holds no audio.
    with _labelling_slot, _inference_slots:
        watch.check()
        audio = _decode_upload(upload)
        _refuse_long_recording(audio)
        watch.check()
        segments, detected = _whisper_segments(audio, opts, watch)
        watch.check()
        labelled = diarization.label_speakers(segments, audio, detected, *speaker_bounds)
    return build_response(labelled, detected, with_speakers=True)


# Plain `def` (audit B1): FastAPI runs sync endpoints in its threadpool, so the
# event loop stays free. The request guard (request_guard.py) has already
# checked the key, the body size and the queue before the upload was parsed.
@app.post("/transcribe")
def transcribe(request: Request, file: UploadFile = File(...), model: str = Form("small"),
               language: str = Form("auto"),
               vocabulary: Annotated[str, Form(max_length=131072)] = "",
               diarize: Annotated[bool, Form()] = False,
               min_speakers: Annotated[Optional[int], Form()] = None,
               max_speakers: Annotated[Optional[int], Form()] = None):
    _validate(model, language)
    _validate_speakers(min_speakers, max_speakers)
    _validate_upload_size(file)
    opts, watch = WhisperOptions(model, language, vocabulary), DisconnectWatch(request)
    try:
        if not diarize:
            return _transcribe_plain(file.file, opts, watch)
        diarization.check_available()  # cheap: before any audio work
        return _transcribe_with_speakers(file.file, opts, watch, (min_speakers, max_speakers))
    except diarization.DiarizationUnavailable as err:
        raise HTTPException(400, DIARIZATION_UNAVAILABLE + str(err)) from err
    except ClientDisconnected as err:
        log.info("Client disconnected; stopped its transcription early")
        raise HTTPException(CLIENT_CLOSED_REQUEST, "Client closed the request.") from err


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=os.environ.get("STT_HOST", "127.0.0.1"),
        port=int(os.environ.get("STT_PORT", "8000")),
    )
