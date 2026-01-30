#!/bin/bash
# local-docker-compose-entrypoint.sh - Entrypoint for local docker-compose development
#
# This script is only used when building for local-docker provider (SANDBOX_ITERATE_REPO_REF not set).
# It handles cloning the repo from the mounted host .git directory at container startup,
# then hands off to the common after-git-clone.sh for shared setup steps.
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

ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

echo "=== Local Docker dev setup ==="

# Remove placeholder dir created by Dockerfile
rm -rf "$ITERATE_REPO"

# Check if .host-git is a worktree gitdir file (not a real .git dir)
if [ -f /home/iterate/.host-git ] && grep -q "^gitdir:" /home/iterate/.host-git 2>/dev/null; then
  echo "ERROR: Detected git worktree. The mounted .git is a file, not a directory."
  echo ""
  echo "For worktrees, set LOCAL_DOCKER_GIT_DIR to the main repo's .git directory:"
  echo "  LOCAL_DOCKER_GIT_DIR=/path/to/main/repo/.git docker compose up"
  echo ""
  echo "Or use alchemy.run.ts which handles this automatically."
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
