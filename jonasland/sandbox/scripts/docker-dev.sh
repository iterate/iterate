#!/bin/bash
#
# Start a tmux session with:
#   Left pane  — egress proxy (bypass mode, logging + HAR recording)
#   Right pane — interactive shell inside a jonasland sandbox container
#
# All sandbox HTTPS traffic routes through the host-side proxy, so you can
# see every outbound request in the left pane. Traffic is recorded to a HAR
# file under jonasland/e2e/artifacts/docker-dev/.
#
# Usage:
#   jonasland/sandbox/scripts/docker-dev.sh
#   jonasland/sandbox/scripts/docker-dev.sh --image jonasland-sandbox:local
#   jonasland/sandbox/scripts/docker-dev.sh --no-pidnap
#   jonasland/sandbox/scripts/docker-dev.sh --proxy-port 9090
#   jonasland/sandbox/scripts/docker-dev.sh --env OPENAI_API_KEY
#
# Extra flags are forwarded to docker-shell.ts (--image, --no-pidnap, --env, etc.)
# The egress proxy port can be set with --proxy-port (default: 19555).

set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SESSION="jonasland-dev"
PROXY_PORT=19555
DOCKER_SHELL_ARGS=()
HAS_IMAGE_FLAG=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
    --proxy-port=*) PROXY_PORT="${1#*=}"; shift ;;
    --image|--image=*) HAS_IMAGE_FLAG=true; DOCKER_SHELL_ARGS+=("$1"); shift ;;
    *) DOCKER_SHELL_ARGS+=("$1"); shift ;;
  esac
done

# Default to jonasland-sandbox:latest (locally built) unless the user passed --image.
# This avoids picking up a stale remote tag from Doppler's JONASLAND_SANDBOX_IMAGE.
if [[ "$HAS_IMAGE_FLAG" == "false" ]]; then
  DOCKER_SHELL_ARGS+=("--image" "jonasland-sandbox:latest")
fi

# HAR recording path
HAR_DIR="$REPO_ROOT/jonasland/e2e/artifacts/docker-dev"
mkdir -p "$HAR_DIR"
HAR_FILE="$HAR_DIR/docker-dev-$(date +%Y%m%d-%H%M%S).har"

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Proxy — handles SIGHUP (from tmux session kill) to flush HAR before exiting.
PROXY_CMD="cd '$REPO_ROOT' && echo '📁 HAR: $HAR_FILE' && echo '' && node_modules/.bin/tsx jonasland/scripts/external-egress-proxy.ts --port $PROXY_PORT --record '$HAR_FILE'"

# Container shell — when this exits, send SIGTERM to the proxy pane and wait
# for it to flush the HAR, then kill the session.
SHELL_CMD="cd '$REPO_ROOT/jonasland/sandbox' && doppler run -- tsx scripts/docker-shell.ts --env ITERATE_EXTERNAL_EGRESS_PROXY=http://host.docker.internal:$PROXY_PORT ${DOCKER_SHELL_ARGS[*]:-}; echo '[docker-dev] container exited, flushing HAR...'; tmux send-keys -t $SESSION:main.0 C-c 2>/dev/null; sleep 4; tmux kill-session -t $SESSION 2>/dev/null"

# Create session with proxy pane. remain-on-exit keeps panes open after their
# process exits so we can see the "HAR written" message.
tmux new-session -d -s "$SESSION" -n main "$PROXY_CMD"
tmux set-option -t "$SESSION" remain-on-exit on

# Split horizontally, right pane gets the container shell
tmux split-window -h -t "$SESSION:main" "$SHELL_CMD"

# Give the container pane more space (70%)
tmux resize-pane -t "$SESSION:main.1" -x '70%'

# Select the container pane so you land in the shell
tmux select-pane -t "$SESSION:main.1"

# Attach (skip if no TTY — e.g. when run from an IDE or script)
if [ -t 0 ]; then
  exec tmux attach-session -t "$SESSION"
else
  echo "[docker-dev] tmux session '$SESSION' created (no TTY — attach manually with: tmux attach -t $SESSION)"
  echo "[docker-dev] HAR recording: $HAR_FILE"
fi
