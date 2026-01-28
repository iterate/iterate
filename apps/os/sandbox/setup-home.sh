#!/bin/bash
set -euo pipefail

# Setup Home Directory
#
# This script copies files from the iterate repo into the user's home directory.
# It's used in TWO places:
#   1. Dockerfile - at image build time to bake in home directory configs
#   2. entry.sh   - at container start in local-docker mode, after rsync,
#                   so local changes to home-skeleton are picked up on restart
#
# Files copied:
#   - home-skeleton/ → $HOME (agent configs for Claude Code, OpenCode, Pi, etc.)

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
HOME_SKELETON="$ITERATE_REPO/apps/os/sandbox/home-skeleton"

echo "Setting up home directory from $HOME_SKELETON..."
cp -r "$HOME_SKELETON"/. "$HOME/"

# Append Daytona-specific instructions if running in Daytona (not local-docker mode)
# Local-docker mode is detected by presence of /local-iterate-repo mount
if [[ ! -d "/local-iterate-repo" ]]; then
  echo "Daytona mode detected, appending port forwarding instructions..."

  DAYTONA_AGENTS="$HOME_SKELETON/.config/opencode/AGENTS.daytona.md"
  if [[ -f "$DAYTONA_AGENTS" ]]; then
    cat "$DAYTONA_AGENTS" >> "$HOME/.config/opencode/AGENTS.md"
  fi
fi
