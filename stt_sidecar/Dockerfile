# syntax=docker/dockerfile:1
# ── Parley STT sidecar (faster-whisper + FastAPI) ─────────────────────────────
# CPU build by default. Whisper models download on first use into /models
# (mounted volume) so they survive container restarts.
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

COPY stt_sidecar/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY stt_sidecar/server.py ./

# The server runs as the unprivileged `stt` user. The container starts as root
# only so the entrypoint can hand an existing (root-owned) /models volume to
# `stt` once, then it drops privileges with setpriv (util-linux, in the base
# image). A new named volume copies the ownership below on first use.
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /models \
      --shell /usr/sbin/nologin stt \
    && mkdir -p /models \
    && chown stt:stt /models
COPY --chmod=755 stt_sidecar/entrypoint.sh /usr/local/bin/stt-entrypoint
VOLUME ["/models"]
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/stt-entrypoint"]
CMD ["python", "server.py"]
