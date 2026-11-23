"""Optional speaker detection: model lifecycle around the WhisperX backend.

A cheap availability report for /health, a lazy load-once under a lock
(mirroring the Whisper model cache in server.py), a remembered load failure
that the next request retries, and one labelling run at a time, after which
cached GPU memory is handed back. The model
work itself is BACKEND's (whisperx_backend.py), kept behind two methods so
tests (and any future backend) can swap it.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Optional, Protocol

import numpy as np

from whisperx_backend import Labeller, WhisperXBackend, release_memory

log = logging.getLogger("stt_sidecar.diarize")


class Backend(Protocol):
    def unavailable_reason(self) -> Optional[str]:
        """Why speaker detection cannot work, or None. Must be cheap: no model load."""

    def load(self) -> Labeller:
        """Load the models (slow, may download). Raise with a readable message on failure."""


class DiarizationUnavailable(Exception):
    """Speaker detection was requested but cannot run; str() is the reason."""


BACKEND: Backend = WhisperXBackend()

_state: dict = {"labeller": None, "error": None}
_load_lock = threading.Lock()
# The models' thread-safety isn't ours to promise, and a long recording's
# alignment + embeddings are memory-hungry: label one file at a time.
_run_lock = threading.Lock()


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def status() -> dict:
    """{"available": bool, "reason": str | None} for /health, without loading."""
    reason = BACKEND.unavailable_reason() or _state["error"]
    return {"available": reason is None, "reason": reason}


def check_available() -> None:
    """Fail fast (before any audio work) if the backend can't run at all."""
    reason = BACKEND.unavailable_reason()
    if reason:
        raise DiarizationUnavailable(reason)


def get_labeller() -> Labeller:
    """The loaded backend, loading it on first use. Raises DiarizationUnavailable."""
    check_available()
    with _load_lock:
        if _state["labeller"] is not None:
            return _state["labeller"]
        try:
            labeller = BACKEND.load()
        except Exception as err:
            reason = _one_line(f"could not load the speaker-detection model: {err}")
            log.warning("Speaker detection unavailable: %s", reason)
            _state.update(error=reason)
            raise DiarizationUnavailable(reason) from err
        _state.update(labeller=labeller, error=None)
        return labeller


def label_speakers(segments: list[dict], audio: np.ndarray, language: str,
                   min_speakers: Optional[int] = None, max_speakers: Optional[int] = None) -> list[dict]:
    """Whisper segments (with words) for 16 kHz mono float32 `audio`, re-timed
    and labelled with speakers. Empty audio comes back unlabelled."""
    labeller = get_labeller()
    if audio.size == 0:
        return segments
    with _run_lock:
        try:
            return labeller(segments, audio, language, min_speakers, max_speakers)
        finally:
            # Alignment and pyannote leave GBs in torch's GPU cache; hand them
            # back between recordings (a no-op on CPU).
            release_memory()
