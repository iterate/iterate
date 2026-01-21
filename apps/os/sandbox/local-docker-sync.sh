#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
LOCAL_REPO_MOUNT="/local-iterate-repo"

if [ ! -d "$LOCAL_REPO_MOUNT" ]; then
  echo "[local-docker-sync] Local repo mount not found, skipping."
  exit 0
fi

mkdir -p "$ITERATE_REPO"

echo "[local-docker-sync] Syncing repo..."
rsync -a --delete --filter=':- .gitignore' "$LOCAL_REPO_MOUNT/" "$ITERATE_REPO/"

if [ -d "$ITERATE_REPO/apps/os/sandbox" ]; then
  chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh 2>/dev/null || true
fi

echo "[local-docker-sync] Installing dependencies..."
(cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

echo "[local-docker-sync] Building daemon..."
(cd "$ITERATE_REPO/apps/daemon" && npx vite build)

echo "[local-docker-sync] Refreshing home-skeleton..."
"$ITERATE_REPO/apps/os/sandbox/setup-home.sh"
