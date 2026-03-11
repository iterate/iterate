#!/bin/bash
#
# Start a tmux session with:
#   Pane 0 (left)  — egress proxy (bypass mode, logging + HAR recording)
#   Pane 1 (right) — interactive shell inside a jonasland sandbox container
#
# An FRP tunnel connects the host-side egress proxy into the container so all
# sandbox HTTPS egress routes through the proxy. Traffic appears in pane 0 and
# is recorded to a HAR file under jonasland/e2e/artifacts/docker-dev/.
#
# This uses frpc (websocket over Caddy) instead of host.docker.internal, so
# the same approach works across the internet — not just local Docker.
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
#
# Requires: frpc (brew install frpc)

set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SESSION="jonasland-dev"
PROXY_PORT=19555
FRP_DATA_PORT=27180
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

if [[ "$HAS_IMAGE_FLAG" == "false" ]]; then
  DOCKER_SHELL_ARGS+=("--image" "jonasland-sandbox:latest")
fi

if ! command -v frpc &>/dev/null; then
  echo "[docker-dev] frpc not found. Install with: brew install frpc" >&2
  exit 1
fi

CONTAINER_NAME="jonasland-dev-$(date +%s | tail -c 5)"

HAR_DIR="/tmp/jonasland-dev"
mkdir -p "$HAR_DIR"
HAR_FILE="$HAR_DIR/docker-dev-$(date +%Y%m%d-%H%M%S).har"

tmux kill-session -t "$SESSION" 2>/dev/null || true

# Pane 0 (left): egress proxy on host
PROXY_CMD="cd '$REPO_ROOT' && echo '📁 HAR: $HAR_FILE' && echo '' && node_modules/.bin/tsx jonasland/scripts/external-egress-proxy.ts --port $PROXY_PORT --record '$HAR_FILE'"

# Pane 1 (right): container shell with FRP setup
# After docker-shell.ts prints "ready", a background job connects frpc and
# writes ITERATE_EGRESS_PROXY into the container's env file.
SHELL_CMD="$(cat <<OUTER_EOF
cd '$REPO_ROOT/jonasland/sandbox'

# Start frpc in background once the container is healthy.
# docker-shell.ts outputs the container ID on a line matching "container=...".
# We use --name so we know the OrbStack hostname upfront.
(
  # Wait for the frp Caddy route to be registered (registry-service must be up)
  echo '[frp-setup] waiting for frp route on $CONTAINER_NAME...'
  for i in \$(seq 1 120); do
    result=\$(curl -sf --max-time 2 http://frp.$CONTAINER_NAME.orb.local/__iterate/caddy-health 2>/dev/null) || true
    if echo "\$result" | grep -q ok; then
      echo '[frp-setup] frp route active via OrbStack'
      break
    fi
    sleep 1
  done

  echo '[frp-setup] connecting frpc to frp.$CONTAINER_NAME.orb.local...'
  frpc tcp \\
    -s frp.$CONTAINER_NAME.orb.local \\
    -P 80 \\
    -p websocket \\
    -l $PROXY_PORT \\
    -r $FRP_DATA_PORT \\
    -n egress-tunnel &
  FRPC_PID=\$!
  sleep 3

  # Write external egress proxy env to container
  docker exec $CONTAINER_NAME bash -c 'echo "ITERATE_EGRESS_PROXY=http://127.0.0.1:$FRP_DATA_PORT" >> ~/.iterate/.env'
  echo '[frp-setup] wrote ITERATE_EGRESS_PROXY to container env'

  # Wait for egress proxy to pick up the change
  for i in \$(seq 1 15); do
    out=\$(docker exec $CONTAINER_NAME curl -fsS http://127.0.0.1:19001/api/runtime 2>/dev/null || true)
    if echo "\$out" | grep -q '"externalProxyConfigured":true'; then
      echo '[frp-setup] egress proxy configured — FRP tunnel active'
      break
    fi
    sleep 1
  done

  wait \$FRPC_PID 2>/dev/null
) &
FRP_SETUP_PID=\$!

doppler run -- tsx scripts/docker-shell.ts \\
  --name $CONTAINER_NAME \\
  ${DOCKER_SHELL_ARGS[*]:-}

echo '[docker-dev] container exited, cleaning up...'
kill \$FRP_SETUP_PID 2>/dev/null
pkill -f "frpc tcp.*egress-tunnel" 2>/dev/null
tmux send-keys -t $SESSION:main.0 C-c 2>/dev/null
sleep 4
tmux kill-session -t $SESSION 2>/dev/null
OUTER_EOF
)"

LOGS_CMD="echo '[logs] waiting for container $CONTAINER_NAME...'; while ! docker inspect $CONTAINER_NAME >/dev/null 2>&1; do sleep 0.5; done; echo '[logs] streaming docker logs...'; docker logs -f $CONTAINER_NAME 2>&1"

tmux new-session -d -s "$SESSION" -n main "$PROXY_CMD"
tmux set-option -t "$SESSION" remain-on-exit on
tmux set -g mouse on
tmux split-window -h -t "$SESSION:main" "$SHELL_CMD"
tmux resize-pane -t "$SESSION:main.1" -x '70%'
tmux split-window -v -t "$SESSION:main.1" "$LOGS_CMD"
tmux resize-pane -t "$SESSION:main.2" -y '30%'
tmux select-pane -t "$SESSION:main.1"

if [ -t 0 ]; then
  exec tmux attach-session -t "$SESSION"
else
  echo "[docker-dev] tmux session '$SESSION' created (no TTY — attach manually with: tmux attach -t $SESSION)"
  echo "[docker-dev] container: $CONTAINER_NAME"
  echo "[docker-dev] HAR recording: $HAR_FILE"
fi
