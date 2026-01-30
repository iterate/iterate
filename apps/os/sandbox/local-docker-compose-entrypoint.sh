#!/bin/bash
# local-docker-compose-entrypoint.sh - Entrypoint for local docker-compose development
#
# This script does the same things at container start time that 
# is normally done at docker image build time. Specifically
#
# 1. pull from git repo (in this case from host machine's .git directory instead of remote)
# 2. then do whatever needs to run after via after-git-clone.sh
#
# The Dockerfile copies this to /app/local-docker-compose-entrypoint.sh only when
# SANDBOX_ITERATE_REPO_REF is NOT set (i.e., local dev builds).
#
# Flow:
#   1. Clone from mounted .host-git directory
#   2. Checkout correct branch/commit
#   3. Run after-git-clone.sh (pnpm install, build daemon, setup home)
#   4. Exec entry.sh (proxy config, pidnap)

set -e

# ITERATE_REPO is set as ENV in Dockerfile

# Fast path: if already set up, just run entry.sh
if [ -d "$ITERATE_REPO/node_modules" ]; then
  echo "=== Fast restart (repo already set up) ==="
  exec /app/entry.sh
fi

echo "=== Local Docker dev setup ==="

# Remove placeholder dir created by Dockerfile
rm -rf "$ITERATE_REPO"

# Check if .host-git is a worktree gitdir file (not a real .git dir)
if [ -f /home/iterate/.host-git ] && grep -q "^gitdir:" /home/iterate/.host-git 2>/dev/null; then
  echo "ERROR: Detected git worktree. The mounted .git is a file, not a directory."
  echo ""
  echo "For worktrees, use scripts/docker-compose-env.sh which resolves to main .git:"
  echo "  scripts/docker-compose-env.sh docker compose up"
  echo ""
  exit 1
fi

# Clone from mounted host .git directory
# This gives container its own copy with full git history
echo "Cloning from host .git directory..."
git clone file:///home/iterate/.host-git "$ITERATE_REPO"

# Checkout the correct branch/commit
cd "$ITERATE_REPO"
if [ -n "${LOCAL_DOCKER_GIT_BRANCH:-}" ]; then
  echo "Checking out branch: $LOCAL_DOCKER_GIT_BRANCH"
  git checkout "$LOCAL_DOCKER_GIT_BRANCH"
else
  # No branch - checkout commit directly (detached HEAD, same as host)
  echo "Checking out commit: ${LOCAL_DOCKER_GIT_COMMIT:-HEAD}"
  git checkout "${LOCAL_DOCKER_GIT_COMMIT:-HEAD}"
fi

echo ""
echo "Git status:"
git status --short
echo ""

# Run common setup (use the one from /app which was copied during image build,
# not the cloned repo - in case someone is on a branch without this script)
bash /app/after-git-clone.sh

# Hand off to universal entrypoint (proxy config, pidnap)
exec /app/entry.sh
