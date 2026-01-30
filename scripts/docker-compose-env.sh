#!/bin/bash
# Set LOCAL_DOCKER_* env vars for docker-compose and run a command.
#
# Usage:
#   scripts/docker-compose-env.sh docker compose up
#   scripts/docker-compose-env.sh -- docker compose up  # -- is optional
#
# Handles git worktrees by resolving to the main .git directory.
# Also sets COMPOSE_PROJECT_NAME to avoid conflicts between worktrees.

set -euo pipefail

# Ensure shared pnpm store volume exists (idempotent)
docker volume create iterate-pnpm-store >/dev/null 2>&1 || true

# Find repo root (directory containing this script's parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GIT_PATH="$REPO_ROOT/.git"

# Resolve worktrees: .git file contains "gitdir: /path/to/.git/worktrees/name"
if [ -f "$GIT_PATH" ]; then
  # Worktree: parse gitdir and resolve to main .git
  WORKTREE_GIT_DIR=$(grep "^gitdir:" "$GIT_PATH" | sed 's/^gitdir: *//')
  # Go up from .git/worktrees/name to .git
  MAIN_GIT_DIR=$(cd "$WORKTREE_GIT_DIR/../.." && pwd)
else
  MAIN_GIT_DIR="$GIT_PATH"
fi

# Resolve symlinks for clean path
MAIN_GIT_DIR=$(realpath "$MAIN_GIT_DIR")

# Get current commit and branch
GIT_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
GIT_BRANCH=$(git -C "$REPO_ROOT" branch --show-current || true)

# Generate unique project name from directory (avoids conflicts between worktrees)
DIR_HASH=$(echo -n "$REPO_ROOT" | shasum -a 256 | cut -c1-4)
DIR_NAME=$(basename "$REPO_ROOT")
COMPOSE_PROJECT_NAME="iterate-${DIR_NAME}-${DIR_HASH}"

# Export env vars
export LOCAL_DOCKER_GIT_DIR="$MAIN_GIT_DIR"
export LOCAL_DOCKER_GIT_COMMIT="$GIT_COMMIT"
export COMPOSE_PROJECT_NAME

if [ -n "$GIT_BRANCH" ]; then
  export LOCAL_DOCKER_GIT_BRANCH="$GIT_BRANCH"
fi

# Skip optional -- separator
if [ "${1:-}" = "--" ]; then
  shift
fi

# If no command provided, just print the env vars
if [ $# -eq 0 ]; then
  echo "LOCAL_DOCKER_GIT_DIR=$LOCAL_DOCKER_GIT_DIR"
  echo "LOCAL_DOCKER_GIT_COMMIT=$LOCAL_DOCKER_GIT_COMMIT"
  [ -n "${LOCAL_DOCKER_GIT_BRANCH:-}" ] && echo "LOCAL_DOCKER_GIT_BRANCH=$LOCAL_DOCKER_GIT_BRANCH"
  echo "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"
  exit 0
fi

# Run the command with env vars set
exec "$@"
