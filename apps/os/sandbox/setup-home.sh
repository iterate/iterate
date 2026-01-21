#!/bin/bash
set -euo pipefail

# Setup Home Directory
#
# This script copies files from the iterate repo into the user's home directory.
# It's used in TWO places:
#   1. Dockerfile - at image build time to bake in home directory configs
#   2. Daemon bootstrap - in local-docker mode after rsync so home-skeleton changes apply
#
# Files copied:
#   - home-skeleton/ → $HOME (agent configs for Claude Code, OpenCode, Pi, etc.)

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
HOME_SKELETON="$ITERATE_REPO/apps/os/sandbox/home-skeleton"

echo "Setting up home directory from $HOME_SKELETON..."
cp -r "$HOME_SKELETON"/. "$HOME/"
