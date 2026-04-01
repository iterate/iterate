#!/usr/bin/env bash
# Two-pane demo launcher.
# Left pane shows the live SSE stream; right pane prompts for messages and appends them.
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-https://events.iterate.com}"
WORKSHOP_PATH_PREFIX="${WORKSHOP_PATH_PREFIX:-/$(id -un)}"
STREAM_PATH="${STREAM_PATH:-${WORKSHOP_PATH_PREFIX}/hello-world}"
SESSION_NAME="${TMUX_SESSION_NAME:-hello-world-$(date +%s)}"

tmux new-session -d -s "$SESSION_NAME" \
  "cd \"$SCRIPT_DIR\" && BASE_URL=\"$BASE_URL\" WORKSHOP_PATH_PREFIX=\"$WORKSHOP_PATH_PREFIX\" STREAM_PATH=\"$STREAM_PATH\" ./stream-events.sh"

tmux split-window -h -t "$SESSION_NAME":0 \
  "cd \"$SCRIPT_DIR\" && BASE_URL=\"$BASE_URL\" WORKSHOP_PATH_PREFIX=\"$WORKSHOP_PATH_PREFIX\" STREAM_PATH=\"$STREAM_PATH\" ./append-message-loop.sh"

tmux select-layout -t "$SESSION_NAME":0 even-horizontal

if [ "${DETACH:-}" = "1" ]; then
  echo "started tmux session $SESSION_NAME"
  exit 0
fi

if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$SESSION_NAME"
else
  tmux attach-session -t "$SESSION_NAME"
fi
