import ctypes, glob, logging, os, re, shutil, sysconfig, tempfile, threading

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from typing import Annotated

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
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
        except OSError as err:
            log.debug("Could not preload %s (%s); ignoring", path, err)


if STT_DEVICE in ("auto", "cuda"):
    _preload_cuda_libs()

from faster_whisper import WhisperModel, BatchedInferencePipeline, available_models  # noqa: E402 (must follow lib preload above)

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
    }

def _validate(model: str, language: str):
    """Reject bad input with a 400 before anything is loaded or downloaded, so
    the client fails fast instead of retrying a request that cannot succeed."""
    if model not in KNOWN_MODELS:
        raise HTTPException(400, f"Unsupported model {model!r}. Use one of: {', '.join(sorted(KNOWN_MODELS))}.")
    if language != "auto" and not _LANGUAGE_CODE.match(language):
        raise HTTPException(400, f"Unsupported language {language!r}: use 'auto' or an ISO 639-1 code such as 'en'.")


def _transcribe_file(path: str, model: str, language: str, vocabulary: str):
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
            path, language=lang, word_timestamps=True, batch_size=_resolve_batch_size(), **hints)
    else:
        segments, info = m.transcribe(path, language=lang, word_timestamps=True, **hints)
    words, texts = [], []
    for seg in segments:  # lazy: the actual inference runs while iterating
        texts.append(seg.text)
        for w in (getattr(seg, "words", None) or []):
            words.append({"word": w.word, "start": w.start, "end": w.end})
    return {"text": " ".join(t.strip() for t in texts).strip(),
            "words": words,
            "language": getattr(info, "language", language)}


# Plain `def` (audit B1): FastAPI runs sync endpoints in its threadpool, so the
# event loop — and /health — stay responsive during long transcriptions.
@app.post("/transcribe")
def transcribe(file: UploadFile = File(...), model: str = Form("small"), language: str = Form("auto"),
               vocabulary: Annotated[str, Form(max_length=131072)] = ""):
    _validate(model, language)
    suffix = os.path.splitext(file.filename or "a.wav")[1] or ".wav"
    fd, path = tempfile.mkstemp(prefix="stt-", suffix=suffix)
    try:
        # Stream the upload to disk instead of holding a second copy in memory.
        with os.fdopen(fd, "wb") as tmp:
            shutil.copyfileobj(file.file, tmp)
        with _inference_slots:
            return _transcribe_file(path, model, language, vocabulary)
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
