#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: sets up agent environment and starts s6 process supervisor,
# which runs our daemon and the opencode server under supervision.
#
# Two modes:
#   - Local Docker: /local-iterate-repo mount exists → rsync, pnpm install, build
#   - Daytona/CI: image has everything pre-baked → just starts s6
#
# Why rsync in local mode?
#   The docker image already contains the repo, but may be stale. Restarting the container
#   syncs the latest source from the host mount. This means in local dev you can
#   restart a container and any changes to the daemon/s6-daemons/home-skeleton
#   that you made locally will be reflected in the container.

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
ITERATE_REPO_LOCAL_DOCKER_MOUNT="/local-iterate-repo"
S6_DAEMONS="$ITERATE_REPO/apps/os/sandbox/s6-daemons"

echo "=== iterate sandbox ==="

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
  chmod +x "$ITERATE_REPO/apps/os/sandbox/s6-daemons/"*/run 2>/dev/null || true
  chmod +x "$ITERATE_REPO/apps/os/sandbox/s6-daemons/"*/log/run 2>/dev/null || true

  echo "Installing dependencies..."
  (cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && npx vite build)

  # Setup home directory (agent configs from home-skeleton)
  "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"
fi

# --- Start s6 process supervisor ---
echo "Cleaning s6 state..."
rm -rf "$S6_DAEMONS/.s6-svscan"
find "$S6_DAEMONS" -type d -name supervise -exec rm -rf {} + 2>/dev/null || true

echo "Starting s6-svscan..."
echo ""
echo "Reminder - logs will be here:"
echo "  Daemon:   /var/log/iterate-daemon/"
echo "  Opencode: /var/log/opencode/"
echo ""
export ITERATE_REPO
export HOSTNAME="0.0.0.0"

# Signal readiness via file (more reliable than stdout for docker log detection)
touch /tmp/.iterate-sandbox-ready

exec s6-svscan "$S6_DAEMONS"
