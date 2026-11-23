import ctypes, glob, logging, os, re, shutil, sysconfig, tempfile, threading

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from typing import Annotated, Optional

import diarize as diarization
from speaker_transcript import build_response

log = logging.getLogger("stt_sidecar")

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
# Transcriptions running at once. FastAPI's threadpool would otherwise run ~40
# in parallel on one CPU/GPU: no faster overall, but each holds its audio and
# decoder state (and possibly a different model), which can exhaust memory.
STT_MAX_CONCURRENCY = max(1, int(os.environ.get("STT_MAX_CONCURRENCY") or 2))


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

app = FastAPI()
_state = {"model": None, "model_name": None, "device": None, "compute": None, "batched": None, "batched_for": None}
# One model load/swap at a time: concurrent cold requests used to each build a
# WhisperModel (2x RAM or more) and race on _state.
_model_lock = threading.Lock()
_inference_slots = threading.BoundedSemaphore(STT_MAX_CONCURRENCY)
# Only faster-whisper's own model names: anything else would be fetched from
# the Hugging Face Hub (or opened as a local path) on the client's say-so.
KNOWN_MODELS = frozenset(available_models())
_LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}$")
# Whisper's (and the diarizer's) input rate: diarized uploads are decoded once
# to 16 kHz mono and the same samples go to both.
SAMPLE_RATE = 16000
MIN_SPEAKERS, MAX_SPEAKERS = 1, 20
DIARIZATION_UNAVAILABLE = "Speaker detection is not enabled on this sidecar: "


def _resolve_batch_size():
    """Effective batch size: explicit env wins; else per-device default (GPU can
    hold a bigger batch than CPU). Returns 0 to mean 'disabled' (sequential)."""
    if STT_BATCH_SIZE is not None:
        return max(0, STT_BATCH_SIZE)
    return 8 if _state["device"] == "cuda" else 4

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
    """Build the model on the first device that works (caller holds _model_lock)."""
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
    if _resolve_batch_size() <= 0:
        return None
    # A real faster-whisper model exposes feature_extractor; the batched pipeline
    # needs it. Guard so fakes/unsupported models fall back cleanly instead of
    # raising deep inside transcribe().
    if not hasattr(model, "feature_extractor"):
        return None
    with _model_lock:
        if _state["batched"] is not None and _state["batched_for"] is model:
            return _state["batched"]
        try:
            batched = BatchedInferencePipeline(model=model)
        except Exception as err:  # unsupported — fall back
            log.warning("Batched pipeline unavailable (%s); using sequential", err)
            return None
        _state.update(batched=batched, batched_for=model)
        return batched

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": _state["model_name"],
        "device": _state["device"],
        "compute": _state["compute"],
        "batch_size": _resolve_batch_size(),
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


def _whisper_segments(audio, model: str, language: str, vocabulary: str) -> tuple[list[dict], str]:
    """Transcribe `audio` (a file path, or 16 kHz mono samples as a numpy array)
    into nested segments [{start, end, text, words: [{word, start, end}]}]
    plus the (detected) language."""
    m = get_model(model)
    lang = None if language == "auto" else language
    supported = getattr(m, "supported_languages", None)
    if lang and supported and lang not in supported:
        raise HTTPException(400, f"Model {model!r} does not support language {lang!r}.")
    hints = {"hotwords": vocabulary.strip()} if vocabulary.strip() else {}
    # Prefer the batched pipeline (parallel VAD segments, 1.7-2.6x faster);
    # fall back to the plain model when batching is off/unavailable.
    batched = get_batched(m)
    if batched is not None:
        segments, info = batched.transcribe(
            audio, language=lang, word_timestamps=True, batch_size=_resolve_batch_size(), **hints)
    else:
        segments, info = m.transcribe(audio, language=lang, word_timestamps=True, **hints)
    # Lazy: the actual inference runs while iterating.
    nested = [{"start": seg.start, "end": seg.end, "text": seg.text,
               "words": [{"word": w.word, "start": w.start, "end": w.end}
                         for w in (getattr(seg, "words", None) or [])]}
              for seg in segments]
    return nested, getattr(info, "language", language)


def _transcribe_file(path: str, model: str, language: str, vocabulary: str) -> dict:
    return build_response(*_whisper_segments(path, model, language, vocabulary))


def _transcribe_with_speakers(path: str, model: str, language: str, vocabulary: str,
                              min_speakers: Optional[int], max_speakers: Optional[int]) -> dict:
    """WhisperX-style: faster-whisper transcript, then alignment + speakers."""
    diarization.get_labeller()  # load (or refuse with a 400) before spending time on Whisper
    audio = decode_audio(path, sampling_rate=SAMPLE_RATE)  # decoded once, shared by every stage
    segments, detected = _whisper_segments(audio, model, language, vocabulary)
    labelled = diarization.label_speakers(segments, audio, detected, min_speakers, max_speakers)
    return build_response(labelled, detected, with_speakers=True)


# Plain `def` (audit B1): FastAPI runs sync endpoints in its threadpool, so the
# event loop — and /health — stay responsive during long transcriptions.
@app.post("/transcribe")
def transcribe(file: UploadFile = File(...), model: str = Form("small"), language: str = Form("auto"),
               vocabulary: Annotated[str, Form(max_length=131072)] = "",
               diarize: Annotated[bool, Form()] = False,
               min_speakers: Annotated[Optional[int], Form()] = None,
               max_speakers: Annotated[Optional[int], Form()] = None):
    _validate(model, language)
    _validate_speakers(min_speakers, max_speakers)
    try:
        if diarize:
            diarization.check_available()  # cheap: before the upload is even saved
        return _transcribe_upload(file, model, language, vocabulary,
                                  (min_speakers, max_speakers) if diarize else None)
    except diarization.DiarizationUnavailable as err:
        raise HTTPException(400, DIARIZATION_UNAVAILABLE + str(err)) from err


def _transcribe_upload(file: UploadFile, model: str, language: str, vocabulary: str,
                       speaker_bounds: Optional[tuple[Optional[int], Optional[int]]]) -> dict:
    """Save the upload to a temp file and transcribe it (with speakers when
    `speaker_bounds` = (min_speakers, max_speakers) is given)."""
    suffix = os.path.splitext(file.filename or "a.wav")[1] or ".wav"
    fd, path = tempfile.mkstemp(prefix="stt-", suffix=suffix)
    try:
        # Stream the upload to disk instead of holding a second copy in memory.
        with os.fdopen(fd, "wb") as tmp:
            shutil.copyfileobj(file.file, tmp)
        with _inference_slots:
            if speaker_bounds is None:
                return _transcribe_file(path, model, language, vocabulary)
            return _transcribe_with_speakers(path, model, language, vocabulary, *speaker_bounds)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass  # cleanup failure must not mask a transcription error

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=os.environ.get("STT_HOST", "127.0.0.1"),
        port=int(os.environ.get("STT_PORT", "8000")),
    )
