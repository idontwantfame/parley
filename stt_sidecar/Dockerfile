# syntax=docker/dockerfile:1
# ── Parley STT sidecar (faster-whisper + FastAPI) ─────────────────────────────
# CPU build by default. Whisper models download on first use into /models
# (mounted volume) so they survive container restarts. Build with
# --build-arg WITH_DIARIZATION=1 for the *-full image with speaker detection
# (WhisperX); its alignment/diarization models also cache under /models.
#
# SECURITY: the sidecar has no authentication unless STT_API_KEY is set; then
# every endpoint but /health needs "Authorization: Bearer <STT_API_KEY>" (give
# the bot the same value). Without a key, never publish port 8000 beyond the
# compose network or a trusted LAN: anyone who reaches it can make it transcribe
# (CPU/GPU time, uploads up to STT_MAX_UPLOAD_BYTES). Other limits:
# STT_MAX_CONCURRENCY, STT_MAX_QUEUE, STT_MAX_DIARIZE_SECONDS (see server.py).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    STT_HOST=0.0.0.0 \
    STT_PORT=8000

WORKDIR /app

# libgomp1 is required by faster-whisper's CTranslate2 backend.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY stt_sidecar/requirements.txt stt_sidecar/requirements-diarize.txt ./
# WITH_DIARIZATION=1 builds the *-full image: WhisperX + pyannote (torch,
# several GB) for optional speaker detection, plus the NLTK sentence splitter
# WhisperX alignment would otherwise download at runtime. The default (0)
# installs exactly what it always did.
ARG WITH_DIARIZATION=0
RUN case "$WITH_DIARIZATION" in \
      0) pip install --no-cache-dir -r requirements.txt ;; \
      1) pip install --no-cache-dir -r requirements-diarize.txt \
         && python -m nltk.downloader -d /usr/local/share/nltk_data punkt_tab ;; \
      *) echo "WITH_DIARIZATION must be 0 or 1, got '$WITH_DIARIZATION'" >&2; exit 1 ;; \
    esac

# Everything runs locally. Every model cache lives in the /models volume:
# Hugging Face repos (Whisper, pyannote, wav2vec2 aligners) under HF_HOME,
# torchaudio's alignment checkpoints under TORCH_HOME. After the first
# download HF_HUB_OFFLINE=1 can be set to forbid hub calls. No telemetry:
# huggingface_hub's and pyannote's are off (both inert in the default image).
ENV TORCH_HOME=/models/torch \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PYANNOTE_METRICS_ENABLED=false

COPY stt_sidecar/server.py stt_sidecar/request_guard.py stt_sidecar/diarize.py \
     stt_sidecar/whisperx_backend.py stt_sidecar/speaker_transcript.py ./

# The server runs as the unprivileged `stt` user. The container starts as root
# only so the entrypoint can hand an existing (root-owned) /models volume, and
# HF_HOME/TORCH_HOME inside it, to `stt` once; then it drops privileges with
# setpriv --no-new-privs (util-linux, in the base image). A new named volume
# copies the ownership below on first use.
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /models \
      --shell /usr/sbin/nologin stt \
    && mkdir -p /models \
    && chown stt:stt /models
COPY --chmod=755 stt_sidecar/entrypoint.sh /usr/local/bin/stt-entrypoint
VOLUME ["/models"]
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/stt-entrypoint"]
CMD ["python", "server.py"]
