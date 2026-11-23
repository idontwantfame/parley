"""WhisperX speaker detection: alignment, pyannote diarization, assignment.

Transcription stays on the sidecar's faster-whisper path; this backend then
(1) re-times each segment's words with WhisperX's wav2vec2 alignment for the
detected language (best effort: anything it can't align keeps Whisper's own
word timestamps), (2) runs whisperx.diarize.DiarizationPipeline (pyannote,
default model pyannote/speaker-diarization-community-1) and (3) labels words
and segments with whisperx.assign_word_speakers.

whisperx is only installed in the *-full image (requirements-diarize.txt):
every whisperx/torch import is lazy, so the default image and /health never
touch them.

Runs fully local: models download once (HF_TOKEN needed for the gated
pyannote pipeline) into the /models volume - HF_HOME for Hugging Face repos,
TORCH_HOME for torchaudio's alignment checkpoints - and then load from there,
also with HF_HUB_OFFLINE=1 (no hub calls; the token is then not required).
Telemetry is off: PYANNOTE_METRICS_ENABLED defaults to false here and in the
image, which also sets HF_HUB_DISABLE_TELEMETRY=1.
"""
from __future__ import annotations

import copy
import functools
import gc
import importlib
import importlib.util
import logging
import os
import sys
import threading
import time
import warnings
from collections import OrderedDict
from typing import Any, Callable, Optional

import numpy as np

from speaker_transcript import aligned_or_original

log = logging.getLogger("stt_sidecar.whisperx")

TOKEN_ENV = "HF_TOKEN"
# huggingface_hub's offline switch: models come from the local cache only.
OFFLINE_ENV = "HF_HUB_OFFLINE"
_TRUE_VALUES = {"1", "ON", "YES", "TRUE"}  # as huggingface_hub parses it
# pyannote warns at import that torchcodec (no FFmpeg libs in the image) can't
# decode files. We only hand it in-memory waveforms, so the warning is noise.
_TORCHCODEC_WARNING = r"\s*torchcodec is not installed correctly"
# Unset: whisperx's default, pyannote/speaker-diarization-community-1.
MODEL_ENV = "DIARIZATION_MODEL"
# pyannote.audio 4 reports usage to otel.pyannote.ai unless this is "false".
# A self-hosted bot shouldn't phone home by default; operators can opt in.
TELEMETRY_ENV = "PYANNOTE_METRICS_ENABLED"

# wav2vec2 alignment models kept loaded (each ~0.4-1.2 GB): the most recently
# used languages; a third language evicts the least recently used one.
MAX_ALIGN_MODELS = 2
# A failed alignment-model load (e.g. a hub timeout) is not retried for this
# long, so every request doesn't wait for the same timeout again.
ALIGN_RETRY_SECONDS = 300
_now = time.monotonic  # patched in tests

# (segments, 16 kHz mono audio, language, min_speakers, max_speakers) -> labelled segments
Labeller = Callable[[list[dict], np.ndarray, str, Optional[int], Optional[int]], list[dict]]
AlignModel = tuple[Any, dict]  # (wav2vec2 model, whisperx alignment metadata)


@functools.lru_cache(maxsize=1)
def whisperx_installed() -> bool:
    return importlib.util.find_spec("whisperx") is not None


def _token() -> str:
    return os.environ.get(TOKEN_ENV, "").strip()


def _offline() -> bool:
    return os.environ.get(OFFLINE_ENV, "").strip().upper() in _TRUE_VALUES


def _device() -> str:
    torch = importlib.import_module("torch")
    if os.environ.get("STT_DEVICE", "auto") != "cpu" and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _scrub(text: str, secret: str) -> str:
    return text.replace(secret, "***") if secret else text


def release_memory() -> None:
    """Collect garbage and hand torch's cached GPU memory back to the driver.

    Never imports torch: if nothing loaded it there is nothing to free, and on
    CPU (or a CPU-only torch) the cache flush is skipped.
    """
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is None:
        return
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as err:  # a broken CUDA context must not fail the request that just finished
        log.warning("Could not release cached GPU memory (%s)", err)


class WhisperXBackend:
    def unavailable_reason(self) -> Optional[str]:
        """Cheap: checks the package and token only, never loads a model."""
        if not whisperx_installed():
            return "WhisperX is not installed (use the parley-sidecar *-full image)"
        if not _token() and not _offline():  # offline: cached models need no token
            return ("HF_TOKEN is not set (a Hugging Face read token whose account accepted "
                    "the terms of pyannote/speaker-diarization-community-1)")
        return None

    def load(self) -> Labeller:
        """Load the diarization pipeline (downloads it on first use)."""
        token = _token()
        os.environ.setdefault(TELEMETRY_ENV, "false")
        device = _device()
        try:
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=_TORCHCODEC_WARNING)
                pipeline_class = importlib.import_module("whisperx.diarize").DiarizationPipeline
                pipeline = pipeline_class(model_name=os.environ.get(MODEL_ENV) or None, token=token, device=device)
        except Exception as err:
            # `from None`: the original message/traceback may embed the token.
            raise RuntimeError(_scrub(f"{type(err).__name__}: {err}", token)) from None
        log.info("WhisperX diarization pipeline loaded on %s", device)
        return _Labeller(pipeline, device)


class _Labeller:
    def __init__(self, pipeline: Any, device: str) -> None:
        self._pipeline = pipeline
        self._device = device
        self._align_models: OrderedDict[str, AlignModel] = OrderedDict()  # LRU, newest last
        self._no_align_model: set[str] = set()  # languages WhisperX has no aligner for
        self._retry_after: dict[str, float] = {}  # language -> when a failed load may be retried
        self._align_lock = threading.Lock()

    def __call__(self, segments: list[dict], audio: np.ndarray, language: str,
                 min_speakers: Optional[int], max_speakers: Optional[int]) -> list[dict]:
        aligned = self._align(segments, audio, language)
        turns = self._pipeline(audio, min_speakers=min_speakers, max_speakers=max_speakers)
        whisperx = importlib.import_module("whisperx")
        # assign_word_speakers labels in place: hand it a copy.
        return whisperx.assign_word_speakers(turns, {"segments": copy.deepcopy(aligned)})["segments"]

    def _align(self, segments: list[dict], audio: np.ndarray, language: str) -> list[dict]:
        model = self._align_model(language)
        if model is None:
            return [dict(seg) for seg in segments]
        return [out for seg in segments for out in aligned_or_original(seg, self._align_segment(seg, model, audio))]

    def _align_segment(self, segment: dict, model: AlignModel, audio: np.ndarray) -> list[dict]:
        """One segment at a time, so a failure only costs that segment its alignment."""
        align_model, metadata = model
        transcript = [{"start": segment["start"], "end": segment["end"], "text": segment["text"]}]
        try:
            whisperx = importlib.import_module("whisperx")
            return whisperx.align(transcript, align_model, metadata, audio, self._device)["segments"]
        except Exception as err:
            log.warning("Could not align the segment at %.1fs (%s); keeping Whisper's word timings",
                        segment["start"], err)
            return []

    def _align_model(self, language: str) -> Optional[AlignModel]:
        """The alignment model for `language`, loaded on first use and kept
        while among the MAX_ALIGN_MODELS most recent. None when WhisperX has
        none (remembered) or it failed to load (retried after ALIGN_RETRY_SECONDS)."""
        with self._align_lock:
            if language in self._align_models:
                self._align_models.move_to_end(language)
                return self._align_models[language]
            if language in self._no_align_model or _now() < self._retry_after.get(language, 0.0):
                return None
            if not _has_align_model(language):
                log.info("WhisperX has no alignment model for %r; keeping Whisper's word timings", language)
                self._no_align_model.add(language)
                return None
            self._make_room()
            return self._load_align_model(language)

    def _make_room(self) -> None:
        """Evict least recently used models before loading, so three never coexist (caller holds _align_lock)."""
        while len(self._align_models) >= MAX_ALIGN_MODELS:
            evicted = next(iter(self._align_models))
            del self._align_models[evicted]  # no reference may survive into release_memory()
            log.info("Unloaded the %r alignment model (keeping the %d most recent)", evicted, MAX_ALIGN_MODELS)
            release_memory()

    def _load_align_model(self, language: str) -> Optional[AlignModel]:
        """Load and cache, or remember the failure for a while (caller holds _align_lock)."""
        try:
            whisperx = importlib.import_module("whisperx")
            model = whisperx.load_align_model(language_code=language, device=self._device)
        except Exception as err:
            self._retry_after[language] = _now() + ALIGN_RETRY_SECONDS
            log.warning("Could not load the %r alignment model (%s); keeping Whisper's word timings "
                        "(retrying in %d s)", language, err, ALIGN_RETRY_SECONDS)
            return None
        self._retry_after.pop(language, None)
        self._align_models[language] = model
        return model


def _has_align_model(language: str) -> bool:
    alignment = importlib.import_module("whisperx.alignment")
    return language in alignment.DEFAULT_ALIGN_MODELS_TORCH or language in alignment.DEFAULT_ALIGN_MODELS_HF
