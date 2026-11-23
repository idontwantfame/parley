#!/bin/sh
# Start as root only long enough to make the model cache usable by the
# unprivileged `stt` user, then run the server as that user.
#
# Images before the non-root change ran as root, so an existing whisper-models
# volume holds root-owned files and a non-root server could no longer download
# models into it. Ownership is fixed once, only when something under the cache
# isn't owned by `stt`; afterwards this is a quick no-op check.
set -eu

RUN_AS=stt
MODELS_DIR="${HF_HOME:-/models}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$MODELS_DIR"
  if [ -n "$(find "$MODELS_DIR" ! -user "$RUN_AS" -print -quit)" ]; then
    echo "stt-entrypoint: giving $RUN_AS ownership of $MODELS_DIR (created by an older image)" >&2
    chown -R "$RUN_AS:$RUN_AS" "$MODELS_DIR"
  fi
  HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
  export HOME
  exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --init-groups -- "$@"
fi

# Already unprivileged (e.g. started with --user): nothing to fix up.
exec "$@"
