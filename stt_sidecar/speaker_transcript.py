"""Pure helpers that shape Whisper segments into the /transcribe response.

A "segment" here is {"start", "end", "text", "words": [{"word", "start", "end"}]}
(nested, as faster-whisper and WhisperX produce them), optionally carrying a
"speaker" on the segment and its words after speaker assignment.
"""
from __future__ import annotations

import math
from numbers import Real
from typing import Iterable, Mapping, Sequence

TIME_DECIMALS = 3  # milliseconds, as whisperx rounds its own alignments


def _is_time(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def _timed(item: Mapping) -> bool:
    return _is_time(item.get("start")) and _is_time(item.get("end"))


def _usable_alignment(aligned: Sequence[Mapping]) -> bool:
    """WhisperX leaves an unalignable segment without words, or a word
    without (or with NaN) timings: those keep Whisper's own word timestamps."""
    return bool(aligned) and all(
        _timed(sub) and sub.get("words") and all(_timed(w) for w in sub["words"])
        for sub in aligned)


def _is_spaced(original: Mapping) -> bool:
    """faster-whisper words carry their leading space (" Hello") except in
    languages written without spaces; WhisperX strips it. The bot joins words
    as-is when they are spaced, so aligned words must match Whisper's style."""
    words = original.get("words") or []
    first = words[0]["word"] if words else original.get("text", "")
    return first[:1].isspace()


def _seconds(value: Real) -> float:
    return round(float(value), TIME_DECIMALS)


def aligned_or_original(original: Mapping, aligned: Sequence[Mapping]) -> list[dict]:
    """The aligned sentence(s) for one Whisper segment, or the segment itself
    when WhisperX could not align every word of it."""
    if not _usable_alignment(aligned):
        return [dict(original)]
    space = " " if _is_spaced(original) else ""
    return [{"start": _seconds(sub["start"]), "end": _seconds(sub["end"]), "text": sub.get("text", ""),
             "words": [{"word": space + str(w["word"]).strip(), "start": _seconds(w["start"]),
                        "end": _seconds(w["end"])} for w in sub["words"]]}
            for sub in aligned]


def speakers_in_order(items: Iterable[Mapping]) -> list[str]:
    """Distinct non-null speaker labels, ordered by when they first speak."""
    seen: dict[str, None] = {}
    for item in sorted(items, key=lambda it: it.get("start") or 0.0):
        speaker = item.get("speaker")
        if speaker is not None:
            seen.setdefault(speaker, None)
    return list(seen)


def _word(word: Mapping, with_speakers: bool) -> dict:
    out = {"word": word["word"], "start": word["start"], "end": word["end"]}
    return {**out, "speaker": word.get("speaker")} if with_speakers else out


def _line(segment: Mapping, with_speakers: bool) -> dict:
    out = {"start": segment["start"], "end": segment["end"], "text": segment["text"].strip()}
    return {**out, "speaker": segment.get("speaker")} if with_speakers else out


def build_response(segments: Sequence[Mapping], language: str, with_speakers: bool = False) -> dict:
    """The /transcribe body. Segments become the sentence-sized lines the
    dashboard can seek to; with_speakers adds a speaker (or None) to every word
    and line plus the distinct `speakers` in order of first appearance."""
    words = [_word(w, with_speakers) for seg in segments for w in (seg.get("words") or [])]
    lines = [_line(seg, with_speakers) for seg in segments if seg["text"].strip()]
    body = {"text": " ".join(seg["text"].strip() for seg in segments).strip(),
            "words": words, "segments": lines, "language": language}
    if with_speakers:
        body["speakers"] = speakers_in_order([*words, *lines])
    return body
