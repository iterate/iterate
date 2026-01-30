#!/bin/bash
set -euo pipefail

# We need to Sync the files before pidnap can load the config file
# Once that's done, pidnap takes over

# Sandbox entrypoint: sets up agent environment and starts pidnap process manager,
# which runs our daemon and the opencode server under supervision.
#
# Two modes:
#   - Local Docker: /local-iterate-repo mount exists → rsync, pnpm install, build
#   - Daytona/CI: image has everything pre-baked → just starts pidnap
#
# Why rsync in local mode?
#   The docker image already contains the repo, but may be stale. Restarting the container
#   syncs the latest source from the host mount. This means in local dev you can
#   restart a container and any changes to the daemon/home-skeleton
#   that you made locally will be reflected in the container.

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
ITERATE_REPO_LOCAL_DOCKER_MOUNT="/local-iterate-repo"
SANDBOX_DIR="$ITERATE_REPO/apps/os/sandbox"

# --- Local Docker: sync host repo into container ---
if [[ -d "$ITERATE_REPO_LOCAL_DOCKER_MOUNT" ]]; then
  echo "Local mode: syncing host repo (restart container to pick up changes)"

  # Sync using .gitignore patterns (excludes build artifacts, node_modules, etc.)
  # But do include .git so that `git status` inside the container shows the same thing as outside
  rsync -a --delete \
    --filter=':- .gitignore' \
    "$ITERATE_REPO_LOCAL_DOCKER_MOUNT/" "$ITERATE_REPO/"

  echo "Git status:"
  (cd "$ITERATE_REPO" && git status --verbose)

  # NOTE: Do NOT delete $ITERATE_REPO_LOCAL_DOCKER_MOUNT - it's a mount point and rm would fail or
  # worse, delete host files if mounted read-write. The mount is isolated anyway.

  # Make scripts executable (rsync preserves permissions but host may not have +x)
  chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh

  # Patch pidnap package.json to use the built tgz
  sed -i 's|workspace:|file:/app/pidnap.tgz|g' "$ITERATE_REPO/apps/os/sandbox/package.json"

  echo "Installing dependencies..."
  (cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

  # Setup home directory (agent configs from home-skeleton)
  "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"
fi

export ITERATE_REPO

# Signal readiness for tests and stuff
touch /tmp/.iterate-sandbox-ready

# Pidnap take the wheel
exec tini -sg -- pidnap init -c "$SANDBOX_DIR/pidnap.config.ts"
