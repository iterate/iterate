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

REPO="$HOME/src/github.com/iterate/iterate"
LOCAL_MOUNT="/local-iterate-repo"
S6_DAEMONS="$REPO/apps/os/sandbox/s6-daemons"
HOME_SKELETON="$REPO/apps/os/sandbox/home-skeleton"

echo "=== iterate sandbox ==="

# --- Local Docker: sync host repo into container ---
if [[ -d "$LOCAL_MOUNT" ]]; then
  echo "Local mode: syncing host repo (restart container to pick up changes)"

  # Exclude build artifacts and platform-specific dirs (node_modules differs Mac vs Linux)
  # Note: --delete removes files in dest not in source, but won't delete non-empty dirs
  # containing excluded files (like node_modules) - that's expected
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.turbo' \
    --exclude='.cache' \
    --exclude='*.log' \
    --exclude='.next' \
    --exclude='.wrangler' \
    --exclude='.alchemy' \
    --exclude='coverage' \
    --exclude='.env*' \
    "$LOCAL_MOUNT/" "$REPO/"

  # NOTE: Do NOT delete $LOCAL_MOUNT - it's a mount point and rm would fail or
  # worse, delete host files if mounted read-write. The mount is isolated anyway.

  echo "Installing dependencies..."
  (cd "$REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$REPO/apps/daemon" && npx vite build)

  # Copy agent configs (overwrites any existing)
  echo "Copying agent configs from home-skeleton..."
  cp -r "$HOME_SKELETON"/. "$HOME/"
fi

# --- Start s6 process supervisor ---
echo "Cleaning s6 state..."
rm -rf "$S6_DAEMONS/.s6-svscan"
find "$S6_DAEMONS" -type d -name supervise -exec rm -rf {} + 2>/dev/null || true

echo "Starting s6-svscan..."
export ITERATE_REPO="$REPO"
export HOSTNAME="0.0.0.0"
exec s6-svscan "$S6_DAEMONS"
