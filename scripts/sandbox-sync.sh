#!/usr/bin/env bash
#
# Sync repo into the active local-docker sandbox container and restart daemon.
#
# Usage:
#   ./scripts/sandbox-sync.sh              # auto-finds the active machine's container
#   ./scripts/sandbox-sync.sh CONTAINER    # specify container name/id directly
#
# Queries the local postgres DB (via docker-compose) for the active local-docker
# machine, resolves its container name, rsyncs the repo, and restarts daemon-backend.
#
set -euo pipefail

FAST=0
CONTAINER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    *) CONTAINER="$1"; shift ;;
  esac
done

if [ -z "$CONTAINER" ]; then
  # Find the compose project's postgres container
  COMPOSE_PROJECT=$(docker ps --filter "label=com.docker.compose.service=postgres" --format "{{.Label \"com.docker.compose.project\"}}" | head -1)
  if [ -z "$COMPOSE_PROJECT" ]; then
    echo "No docker-compose postgres container found. Is docker:up running?" >&2
    exit 1
  fi

  POSTGRES_CONTAINER=$(docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" --filter "label=com.docker.compose.service=postgres" --format "{{.Names}}" | head -1)

  # Query the DB for the active local-docker machine's container name
  CONTAINER=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d os -tAc \
    "SELECT metadata->>'containerName' FROM machine WHERE state = 'active' AND type = 'local-docker' LIMIT 1;")

  CONTAINER=$(echo "$CONTAINER" | tr -d '[:space:]')

  if [ -z "$CONTAINER" ]; then
    echo "No active local-docker machine found in the database." >&2
    exit 1
  fi

  echo "Active machine container: $CONTAINER"
fi

# Verify container is running
if ! docker inspect "$CONTAINER" > /dev/null 2>&1; then
  echo "Container '$CONTAINER' not found or not running." >&2
  exit 1
fi

# Get pidnap port mapping
PIDNAP_PORT=$(docker inspect "$CONTAINER" --format '{{(index (index .NetworkSettings.Ports "9876/tcp") 0).HostPort}}')

if [ "$FAST" = "1" ]; then
  echo "Fast sync: rsync + home-skeleton only (skipping pnpm install, vite build, db:migrate)..."
  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
    rsync -a --delete --force \
      --filter=":- .gitignore" \
      --filter=":- .git/info/exclude" \
      --exclude=".git" \
      --exclude="node_modules" \
      "/host/repo-checkout/" "${ITERATE_REPO}/"
    # Sync home-skeleton so config files (.config/opencode/AGENTS.md etc.) are updated
    if [ -f "${ITERATE_REPO}/sandbox/sync-home-skeleton.sh" ]; then
      bash "${ITERATE_REPO}/sandbox/sync-home-skeleton.sh"
    fi
  '
else
  echo "Full sync: rsync + pnpm install + vite build + db:migrate..."
  docker exec "$CONTAINER" bash /home/iterate/src/github.com/iterate/iterate/sandbox/providers/docker/sync-repo-from-host.sh
fi

echo "Restarting daemon-backend..."
curl -sf "http://localhost:${PIDNAP_PORT}/rpc/processes/restart" \
  -H 'Content-Type: application/json' \
  -d '{"json":{"target":"daemon-backend"}}' | python3 -m json.tool

echo "Done."
