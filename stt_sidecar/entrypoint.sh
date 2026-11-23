#!/bin/sh
# Start as root only long enough to make the model caches usable by the
# unprivileged `stt` user, then run the server as that user.
#
# Images before the non-root change ran as root, so an existing whisper-models
# volume holds root-owned files and a non-root server could no longer download
# models into it. Ownership is fixed once, only when something under a cache
# isn't owned by `stt`; afterwards this is a quick no-op check.
#
# The caches are the /models volume plus wherever HF_HOME (Hugging Face repos)
# and TORCH_HOME (torchaudio alignment checkpoints) point. Only paths inside
# /models are touched: a cache pointed elsewhere must already be writable by
# `stt` (uid 10001), so a mistyped variable can never chown system files.
set -eu

RUN_AS=stt
MODELS_ROOT=/models

inside_models_root() {
  case "$1" in
    "$MODELS_ROOT" | "$MODELS_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

create_cache_dir() {
  # realpath -m: resolve symlinks and "..", so neither can lead outside /models.
  dir="$(realpath -m -- "$1")"
  if inside_models_root "$dir"; then
    mkdir -p "$dir"
  else
    echo "stt-entrypoint: $1 is outside $MODELS_ROOT; leaving its ownership alone (it must be writable by $RUN_AS)" >&2
  fi
}

if [ "$(id -u)" = "0" ]; then
  # Create every cache first, then one pass over /models covers them all
  # (including parent directories mkdir -p just made as root).
  for cache in "$MODELS_ROOT" "${HF_HOME:-}" "${TORCH_HOME:-}"; do
    if [ -n "$cache" ]; then
      create_cache_dir "$cache"
    fi
  done
  if [ -n "$(find "$MODELS_ROOT" ! -user "$RUN_AS" -print -quit)" ]; then
    echo "stt-entrypoint: giving $RUN_AS ownership of $MODELS_ROOT (created by an older image or as root)" >&2
    chown -R "$RUN_AS:$RUN_AS" "$MODELS_ROOT"
  fi
  HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
  export HOME
  # --no-new-privs: nothing the server runs can regain privileges (setuid binaries, file caps).
  exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --init-groups --no-new-privs -- "$@"
fi

# Already unprivileged (e.g. started with --user): nothing to fix up.
exec "$@"
