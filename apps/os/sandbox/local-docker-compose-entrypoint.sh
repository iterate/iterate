#!/bin/bash
# local-docker-compose-entrypoint.sh - Entrypoint for local docker-compose development
#
# =============================================================================
# CROSS-CONTAINER CACHE ARCHITECTURE
# =============================================================================
#
# Problem: pnpm install takes ~17s even with warm package cache because it creates
# thousands of hardlinks/symlinks. This is slow on Docker volumes.
#
# Solution: Cache the entire node_modules directory by lockfile hash, then use
# `cp -a` to restore it (~4s vs ~17s for pnpm linking).
#
# Volume structure (mounted at /home/iterate/.cross-container-cache/):
#
#   /home/iterate/.cross-container-cache/
#   ├── pnpm-store/           # pnpm content-addressable store (shared across ALL containers)
#   │   └── v10/              # Package tarballs - downloaded once, reused everywhere
#   │       ├── files/
#   │       └── index/
#   └── node-modules/         # Complete node_modules dirs, keyed by lockfile hash
#       ├── a1b2c3d4/         # First 8 chars of sha256(pnpm-lock.yaml)
#       │   ├── .pnpm/        # pnpm's hardlinks to store
#       │   ├── .bin/
#       │   ├── lodash -> .pnpm/lodash@4.17.21/node_modules/lodash
#       │   └── ...
#       └── e5f6g7h8/         # Different lockfile = different cache entry
#
# Why cp -a instead of symlinks?
#   - pnpm doesn't work well with symlinked node_modules (workspace state issues)
#   - cp -a is fast: ~4s for 130k files + 7k symlinks
#   - Alternatives tested: tar (3.7s), rsync (6.5s), pnpm install (17s)
#
# =============================================================================
# STARTUP FLOW
# =============================================================================
#
#   1. Clone repo from host .git directory (~1s)
#   2. Compute SHA256 hash of pnpm-lock.yaml (first 8 chars)
#   3. Check if cached node_modules exists for this hash
#   4. If cache hit:  cp -a from cache (~4s)
#   5. If cache miss: pnpm install (~17s), then cp -a to cache
#   6. Build daemon if needed
#   7. Hand off to entry.sh
#
# =============================================================================
# PERFORMANCE
# =============================================================================
#
#   | Scenario                    | Time   | What happens                    |
#   |-----------------------------|--------|---------------------------------|
#   | Cold (no pnpm store)        | ~52s   | Download packages + link + copy |
#   | Warm store, cold modules    | ~22s   | Link from store (~17s) + copy   |
#   | Warm store, warm modules    | ~5s    | cp -a from cache (~4s)          |
#   | Container restart           | ~0s    | Skip setup entirely             |
#
# =============================================================================

set -e

# Constants
CACHE_ROOT="/home/iterate/.cross-container-cache"
NODE_MODULES_CACHE="$CACHE_ROOT/node-modules"
PNPM_STORE="$CACHE_ROOT/pnpm-store"

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
# Fix cache volume permissions (external volume may be owned by root on first use)
# -----------------------------------------------------------------------------
sudo mkdir -p "$CACHE_ROOT" "$NODE_MODULES_CACHE" "$PNPM_STORE"
sudo chown -R iterate:iterate "$CACHE_ROOT"

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
# Compute lockfile hash for cache lookup
# -----------------------------------------------------------------------------
LOCK_HASH=$(sha256sum "$ITERATE_REPO/pnpm-lock.yaml" 2>/dev/null | cut -c1-8 || echo "no-lockfile")
CACHE_DIR="$NODE_MODULES_CACHE/$LOCK_HASH"
CACHE_MARKER="$CACHE_DIR/.cache-complete"

echo "Lockfile hash: $LOCK_HASH"
echo "Cache directory: $CACHE_DIR"

# -----------------------------------------------------------------------------
# Setup node_modules from cache or fresh install
# -----------------------------------------------------------------------------
# Make scripts executable (needed before pnpm install for any prepare scripts)
echo "Making scripts executable..."
chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh 2>/dev/null || true

if [ -f "$CACHE_MARKER" ]; then
  # -------------------------------------------------------------------------
  # CACHE HIT: copy cached node_modules (~4s for 130k files)
  # This is 4x faster than pnpm install's linking phase (~17s)
  # -------------------------------------------------------------------------
  echo ""
  echo "=== Cache HIT - copying cached node_modules ==="
  echo "Copying from $CACHE_DIR..."
  time cp -a "$CACHE_DIR" "$ITERATE_REPO/node_modules"
  echo "Done."
else
  # -------------------------------------------------------------------------
  # CACHE MISS: full install, then copy to cache for next time
  # -------------------------------------------------------------------------
  echo ""
  echo "=== Cache MISS - running full pnpm install ==="
  echo "Installing dependencies..."
  pnpm install --no-frozen-lockfile
  
  # Copy node_modules to cache (keep original in place)
  echo ""
  echo "Caching node_modules for next time..."
  rm -rf "$CACHE_DIR"
  cp -a "$ITERATE_REPO/node_modules" "$CACHE_DIR"
  touch "$CACHE_MARKER"
  echo "Cache populated: $CACHE_DIR"
fi

# -----------------------------------------------------------------------------
# Build daemon (included in cache since it outputs to apps/daemon/dist)
# -----------------------------------------------------------------------------
DAEMON_DIST="$ITERATE_REPO/apps/daemon/dist"
if [ -d "$DAEMON_DIST" ] && [ -f "$DAEMON_DIST/index.html" ]; then
  echo ""
  echo "=== Daemon already built ==="
else
  echo ""
  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)
fi

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
