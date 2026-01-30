#!/bin/bash
# local-docker-compose-entrypoint.sh - Entrypoint for local docker-compose development
#
# =============================================================================
# SHARED PNPM STORE
# =============================================================================
#
# Uses a Docker volume at /home/iterate/.cross-container-cache/pnpm-store to share
# downloaded packages across all containers/worktrees. This means packages are only
# downloaded once, even across different branches.
#
# Performance:
#   - Cold start (empty store): ~52s (downloads + links)
#   - Warm start (populated store): ~17s (just linking, no downloads)
#   - Container restart: ~0s (skips setup entirely)
#
# The 17s warm start is pnpm creating ~2000 hardlinks from the store to node_modules.
# We tried caching node_modules by lockfile hash (cp -a ~5s + pnpm install ~7.5s = 12.5s)
# but the 4.5s savings wasn't worth the complexity and 1.5GB disk per lockfile hash.
#
# =============================================================================

set -e

PNPM_STORE="/home/iterate/.cross-container-cache/pnpm-store"

# ITERATE_REPO is set as ENV in Dockerfile
# e.g., /home/iterate/src/github.com/iterate/iterate

# -----------------------------------------------------------------------------
# Fast path: if already set up in this container instance, just run entry.sh
# This handles `docker compose restart` without full rebuild
# -----------------------------------------------------------------------------
if [ -d "$ITERATE_REPO/node_modules" ] && [ -d "$ITERATE_REPO/.git" ]; then
  echo "=== Fast restart (repo already set up) ==="
  exec /app/entry.sh
fi

echo "=== Local Docker dev setup ==="

# -----------------------------------------------------------------------------
# Fix pnpm store permissions (external volume may be owned by root on first use)
# -----------------------------------------------------------------------------
sudo mkdir -p "$PNPM_STORE"
sudo chown -R iterate:iterate "$PNPM_STORE"

# -----------------------------------------------------------------------------
# Validate .host-git mount
# -----------------------------------------------------------------------------
if [ -f /home/iterate/.host-git ] && grep -q "^gitdir:" /home/iterate/.host-git 2>/dev/null; then
  echo "ERROR: Detected git worktree. The mounted .git is a file, not a directory."
  echo ""
  echo "For worktrees, use scripts/docker-compose-env.sh which resolves to main .git:"
  echo "  scripts/docker-compose-env.sh docker compose up"
  echo ""
  exit 1
fi

# -----------------------------------------------------------------------------
# Clone from mounted host .git directory
# -----------------------------------------------------------------------------
rm -rf "$ITERATE_REPO"
echo "Cloning from host .git directory..."
git clone file:///home/iterate/.host-git "$ITERATE_REPO"

# Checkout the correct branch/commit
cd "$ITERATE_REPO"
if [ -n "${LOCAL_DOCKER_GIT_BRANCH:-}" ]; then
  echo "Checking out branch: $LOCAL_DOCKER_GIT_BRANCH"
  git checkout "$LOCAL_DOCKER_GIT_BRANCH"
else
  echo "Checking out commit: ${LOCAL_DOCKER_GIT_COMMIT:-HEAD}"
  git checkout "${LOCAL_DOCKER_GIT_COMMIT:-HEAD}"
fi

echo ""
echo "Git status:"
git status --short
echo ""

# -----------------------------------------------------------------------------
# Install dependencies (uses shared pnpm store for fast package reuse)
# -----------------------------------------------------------------------------
# Make scripts executable (needed before pnpm install for any prepare scripts)
chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh 2>/dev/null || true

echo "Installing dependencies..."
pnpm install --no-frozen-lockfile

# -----------------------------------------------------------------------------
# Build daemon
# -----------------------------------------------------------------------------
echo ""
echo "Building daemon..."
(cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

# -----------------------------------------------------------------------------
# Setup home directory
# -----------------------------------------------------------------------------
mkdir -p ~/.iterate
echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

echo "Setting up home directory..."
bash "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"

echo ""
echo "=== Setup complete ==="
echo ""

# Hand off to universal entrypoint (proxy config, pidnap)
exec /app/entry.sh
