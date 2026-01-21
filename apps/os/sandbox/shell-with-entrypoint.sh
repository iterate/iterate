#!/bin/bash
set -euo pipefail

# Starts the sandbox container, waits for bootstrap to complete, then opens a shell.
#
# Usage: doppler run --config dev -- ./apps/os/sandbox/shell-with-entrypoint.sh
#
# Pass additional docker run args via DOCKER_ARGS env var:
#   DOCKER_ARGS="-v /some/path:/mount" ./shell-with-entrypoint.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

IMAGE="${LOCAL_DOCKER_IMAGE_NAME:-iterate-sandbox:local}"
CONTAINER_NAME="iterate-sandbox-shell-$$"
TIMEOUT=300

cleanup() {
  echo "Stopping container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting container..."
echo "  Mounting local repo: $REPO_ROOT"
docker run -d \
  --name "$CONTAINER_NAME" \
  -e OPENAI_API_KEY \
  -e ANTHROPIC_API_KEY \
  -e ITERATE_OPENCODE_API_KEY \
  -e GITHUB_APP_ID \
  -e GITHUB_APP_PRIVATE_KEY \
  -v "$REPO_ROOT:/local-iterate-repo:ro" \
  ${DOCKER_ARGS:-} \
  "$IMAGE" >/dev/null

# Stream logs in background while waiting for ready signal
docker logs -f "$CONTAINER_NAME" 2>&1 &
LOGS_PID=$!

READY_ENDPOINT="http://localhost:3000/api/health"

start_time=$(date +%s)
while true; do
  # Check for health endpoint inside container
  if docker exec "$CONTAINER_NAME" curl -fsS "$READY_ENDPOINT" >/dev/null 2>&1; then
    kill $LOGS_PID 2>/dev/null || true
    wait $LOGS_PID 2>/dev/null || true
    echo ""
    echo "Setup complete!"
    break
  fi
  
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  if [[ $elapsed -ge $TIMEOUT ]]; then
    kill $LOGS_PID 2>/dev/null || true
    echo "Timeout waiting for container to be ready" >&2
    exit 1
  fi
  
  # Check if container died
  if ! docker ps -q -f "name=$CONTAINER_NAME" | grep -q .; then
    kill $LOGS_PID 2>/dev/null || true
    wait $LOGS_PID 2>/dev/null || true
    echo "Container exited unexpectedly" >&2
    exit 1
  fi
  
  sleep 0.5
done

echo ""
echo "Opening shell in container (Ctrl-D or 'exit' to quit)..."
echo ""
docker exec -it "$CONTAINER_NAME" /bin/bash
