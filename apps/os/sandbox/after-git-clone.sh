#!/bin/bash
# after-git-clone.sh - Common setup that runs after git clone
#
# This script handles the shared setup steps needed after cloning the iterate repo,
# regardless of HOW the repo was cloned. There are two scenarios:
#
# 1. Remote deployment (Daytona) - SANDBOX_ITERATE_REPO_REF is set
#    The Dockerfile clones from GitHub during image build, then runs this script.
#    The pidnap.tgz is available at /app/pidnap.tgz and needs to be patched into package.json.
#
# 2. Local development (docker-compose) - SANDBOX_ITERATE_REPO_REF is NOT set
#    The local-docker-compose-entrypoint.sh clones from mounted .host-git at container start,
#    then calls this script. No pidnap.tgz patching needed (uses workspace: protocol).
#
# Usage: bash after-git-clone.sh [--skip-setup-home]
#   --skip-setup-home: Skip running setup-home.sh (useful if called at build time
#                      when home setup should happen later)

set -e

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
SKIP_SETUP_HOME=false

# Parse args
for arg in "$@"; do
  case $arg in
    --skip-setup-home)
      SKIP_SETUP_HOME=true
      shift
      ;;
  esac
done

cd "$ITERATE_REPO"

# Patch package.json to use built pidnap.tgz if it exists (remote deployment)
if [ -f /app/pidnap.tgz ]; then
  echo "Patching package.json to use /app/pidnap.tgz..."
  sed -i 's|workspace:|file:/app/pidnap.tgz|g' "$ITERATE_REPO/apps/os/sandbox/package.json"
fi

# Make scripts executable
echo "Making scripts executable..."
chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh

# Install dependencies
echo "Installing dependencies..."
pnpm install --no-frozen-lockfile

# Build daemon
echo "Building daemon..."
(cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

# Setup home directory (agent configs from home-skeleton)
if [ "$SKIP_SETUP_HOME" = false ]; then
  echo "Setting up home directory..."
  bash "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"
fi

echo "after-git-clone.sh complete"
