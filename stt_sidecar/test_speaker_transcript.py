"""Pure helpers that turn (aligned, speaker-labelled) segments into the
/transcribe response. No whisperx/torch needed."""
import math

from speaker_transcript import aligned_or_original, build_response, speakers_in_order

ORIGINAL = {"start": 0.0, "end": 2.0, "text": " Hello there. Bye now.",
            "words": [{"word": " Hello", "start": 0.0, "end": 0.4}, {"word": " there.", "start": 0.4, "end": 0.9},
                      {"word": " Bye", "start": 1.2, "end": 1.5}, {"word": " now.", "start": 1.5, "end": 2.0}]}


def aligned_sentence(text, words):
    return {"start": words[0][1], "end": words[-1][2], "text": text,
            "words": [{"word": w, "start": s, "end": e, "score": 0.9} for w, s, e in words]}


# ── aligned_or_original ──────────────────────────────────────────────────────

def test_aligned_sentences_replace_the_segment_with_spaced_words_and_no_scores():
    aligned = [aligned_sentence("Hello there.", [("Hello", 0.05, 0.38), ("there.", 0.42, 0.85)]),
               aligned_sentence("Bye now.", [("Bye", 1.21, 1.47), ("now.", 1.52, 1.93)])]
    assert aligned_or_original(ORIGINAL, aligned) == [
        {"start": 0.05, "end": 0.85, "text": "Hello there.",
         "words": [{"word": " Hello", "start": 0.05, "end": 0.38}, {"word": " there.", "start": 0.42, "end": 0.85}]},
        {"start": 1.21, "end": 1.93, "text": "Bye now.",
         "words": [{"word": " Bye", "start": 1.21, "end": 1.47}, {"word": " now.", "start": 1.52, "end": 1.93}]},
    ]


def test_words_stay_unspaced_when_whisper_did_not_space_them():
    original = {"start": 0.0, "end": 1.0, "text": "你好", "words": [{"word": "你", "start": 0.0, "end": 0.5},
                                                                   {"word": "好", "start": 0.5, "end": 1.0}]}
    aligned = [aligned_sentence("你好", [("你", 0.1, 0.4), ("好", 0.5, 0.9)])]
    assert [w["word"] for w in aligned_or_original(original, aligned)[0]["words"]] == ["你", "好"]


def test_unalignable_segment_keeps_whispers_own_words():
    # whisperx returns the segment with no words when it cannot align it.
    unaligned = [{"start": 0.0, "end": 2.0, "text": " Hello there. Bye now.", "words": []}]
    assert aligned_or_original(ORIGINAL, unaligned) == [ORIGINAL]
    assert aligned_or_original(ORIGINAL, []) == [ORIGINAL]


def test_a_word_without_finite_timings_keeps_whispers_own_words():
    missing = aligned_sentence("Hello there.", [("Hello", 0.05, 0.38), ("there.", 0.42, 0.85)])
    missing["words"][1].pop("start")
    nan = aligned_sentence("Hello there.", [("Hello", 0.05, math.nan), ("there.", 0.42, 0.85)])
    assert aligned_or_original(ORIGINAL, [missing]) == [ORIGINAL]
    assert aligned_or_original(ORIGINAL, [nan]) == [ORIGINAL]


def test_alignment_output_values_are_plain_rounded_floats():
    import numpy as np
    aligned = [aligned_sentence("Hello", [("Hello", np.float64(0.123456), np.float64(0.5))])]
    word = aligned_or_original(ORIGINAL, aligned)[0]["words"][0]
    assert word == {"word": " Hello", "start": 0.123, "end": 0.5}
    assert type(word["start"]) is float


# ── build_response ───────────────────────────────────────────────────────────

SEGMENTS = [{"start": 0.0, "end": 1.0, "text": " hi there", "speaker": "SPEAKER_01",
             "words": [{"word": " hi", "start": 0.0, "end": 0.4, "speaker": "SPEAKER_01"},
                       {"word": " there", "start": 0.5, "end": 1.0}]},
            {"start": 1.0, "end": 1.5, "text": " ", "words": []},
            {"start": 2.0, "end": 3.0, "text": " hello", "speaker": "SPEAKER_00",
             "words": [{"word": " hello", "start": 2.0, "end": 3.0, "speaker": "SPEAKER_00"}]}]


def test_plain_response_matches_the_original_shape():
    plain = [{k: v for k, v in s.items() if k != "speaker"} for s in SEGMENTS]
    plain[0]["words"] = [{"word": " hi", "start": 0.0, "end": 0.4}]
    assert build_response(plain, "en") == {
        # Same join as before this module existed: a blank segment leaves a double space.
        "text": "hi there  hello",
        "words": [{"word": " hi", "start": 0.0, "end": 0.4}, {"word": " hello", "start": 2.0, "end": 3.0}],
        "segments": [{"start": 0.0, "end": 1.0, "text": "hi there"}, {"start": 2.0, "end": 3.0, "text": "hello"}],
        "language": "en"}


def test_speaker_response_labels_every_word_and_segment_and_lists_speakers():
    body = build_response(SEGMENTS, "en", with_speakers=True)
    assert body["words"] == [{"word": " hi", "start": 0.0, "end": 0.4, "speaker": "SPEAKER_01"},
                             {"word": " there", "start": 0.5, "end": 1.0, "speaker": None},
                             {"word": " hello", "start": 2.0, "end": 3.0, "speaker": "SPEAKER_00"}]
    assert body["segments"] == [{"start": 0.0, "end": 1.0, "text": "hi there", "speaker": "SPEAKER_01"},
                                {"start": 2.0, "end": 3.0, "text": "hello", "speaker": "SPEAKER_00"}]
    assert body["speakers"] == ["SPEAKER_01", "SPEAKER_00"]
    assert body["text"] == "hi there  hello" and body["language"] == "en"


def test_build_response_does_not_mutate_its_input():
    import copy
    before = copy.deepcopy(SEGMENTS)
    build_response(SEGMENTS, "en", with_speakers=True)
    assert SEGMENTS == before


# ── speakers_in_order ────────────────────────────────────────────────────────

def test_speakers_are_listed_once_in_order_of_first_appearance():
    items = [{"start": 2.0, "speaker": "A"}, {"start": 0.0, "speaker": "B"},
             {"start": 1.0, "speaker": None}, {"start": 3.0, "speaker": "B"}]
    assert speakers_in_order(items) == ["B", "A"]
    assert speakers_in_order([]) == []
