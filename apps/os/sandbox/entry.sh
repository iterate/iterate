#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: sets up agent environment and starts s6 process supervisor,
# which runs our daemon and the opencode server under supervision (and any other daemons users need!)
#
# Two modes:
#   - Local Docker: /local-iterate-repo mount exists → rsync, pnpm install, build
#   - Daytona: image has everything pre-baked → just starts s6
#
# Why rsync in local mode?
#   The docker image already contains the repo, but may be stale. Restarting the container
#   syncs the latest source from the host mount. This means in local dev you can
#   restart a container and any changes to the daemon that you made locally will be reflected
#   in the container

ITERATE_REPO="$HOME/src/github.com/iterate/iterate"
ITERATE_REPO_LOCAL_DOCKER_MOUNT="/local-iterate-repo"
S6_DAEMONS="/app/s6-daemons"

echo "=== iterate sandbox ==="

# --- Local Docker: sync host repo into container ---
if [[ -d "$ITERATE_REPO_LOCAL_DOCKER_MOUNT" ]]; then
  echo "Local mode: syncing host repo (restart container to pick up changes)"

  # Sync using .gitignore patterns (excludes build artifacts, node_modules, etc.)
  # But do include .git so that `git status` inside the container shows the same thing as outside
  rsync -a --delete \
    --filter=':- .gitignore' \
    "$ITERATE_REPO_LOCAL_DOCKER_MOUNT/" "$ITERATE_REPO/"

  # NOTE: Do NOT delete $ITERATE_REPO_LOCAL_DOCKER_MOUNT - it's a mount point and rm would fail or
  # worse, delete host files if mounted read-write. The mount is isolated anyway.

  echo "Installing dependencies..."
  (cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && npx vite build)

  # Copy agent configs (overwrites any existing)
  echo "Copying agent configs from home-skeleton..."
  HOME_SKELETON="$ITERATE_REPO/apps/os/sandbox/home-skeleton"
  cp -r "$HOME_SKELETON"/. "$HOME/"

  # Sync s6-daemons to /app so local changes are picked up
  echo "Syncing s6-daemons..."
  rsync -a --delete "$ITERATE_REPO/apps/os/sandbox/s6-daemons/" "$S6_DAEMONS/"
fi

# --- Start s6 process supervisor ---
echo "Cleaning s6 state..."
rm -rf "$S6_DAEMONS/.s6-svscan"
find "$S6_DAEMONS" -type d -name supervise -exec rm -rf {} + 2>/dev/null || true

echo "Starting s6-svscan..."
export ITERATE_REPO
export HOSTNAME="0.0.0.0"
exec s6-svscan "$S6_DAEMONS"
