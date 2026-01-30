#!/bin/bash
# after-git-clone.sh - Common setup that runs after git clone either
# 1) when building a daytona image (where we pull during image build) or
# 2) when starting a local docker container using local-docker-compose-entrypoint.sh ,
#    which clones from the host machine's .git directory
set -e

# ITERATE_REPO is set in Dockerfile
cd "$ITERATE_REPO"

# Make scripts executable
echo "Making scripts executable..."
chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh

# Install dependencies
echo "Installing dependencies..."
pnpm install --no-frozen-lockfile

# Build daemon
echo "Building daemon..."
(cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

# Build pidnap and symlink to PATH
echo "Building pidnap..."
(cd "$ITERATE_REPO/packages/pidnap" && pnpm build)
sudo ln -sf "$ITERATE_REPO/packages/pidnap/dist/cli.mjs" /usr/local/bin/pidnap

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
mkdir -p ~/.iterate
echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

# Setup home directory (agent configs from home-skeleton)
echo "Setting up home directory..."
bash "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"

echo "after-git-clone.sh complete"
