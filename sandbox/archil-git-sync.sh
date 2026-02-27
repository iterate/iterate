#!/bin/bash
# Periodically saves uncommitted git changes to the archil persist volume.
# This ensures work-in-progress survives machine reprovisioning.
#
# Runs as a background process managed by pidnap.
# Saves a patch file to /mnt/persist/uncommitted-changes.patch every 30 seconds.
set -euo pipefail

PERSIST="/mnt/persist"
REPO_DIR="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
PATCH_FILE="${PERSIST}/uncommitted-changes.patch"

echo "[git-sync] Starting git change sync (repo: ${REPO_DIR}, persist: ${PERSIST})"

# Wait for archil to mount
while ! grep -q "$PERSIST" /proc/mounts 2>/dev/null; do
  sleep 5
done
echo "[git-sync] Archil mounted, starting periodic sync"

while true; do
  sleep 30

  # Skip if repo doesn't exist or isn't a git repo
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    continue
  fi

  cd "$REPO_DIR"

  # Generate a diff of all uncommitted changes (staged + unstaged + untracked)
  DIFF=$(git diff HEAD 2>/dev/null || true)
  UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)

  if [[ -n "$DIFF" ]] || [[ -n "$UNTRACKED" ]]; then
    # Save the diff
    git diff HEAD > "$PATCH_FILE" 2>/dev/null || true

    # Also save list of untracked files (can't be captured by diff alone)
    if [[ -n "$UNTRACKED" ]]; then
      echo "$UNTRACKED" > "${PERSIST}/untracked-files.txt"
    else
      rm -f "${PERSIST}/untracked-files.txt"
    fi
  else
    # No changes, clean up old patch
    rm -f "$PATCH_FILE" "${PERSIST}/untracked-files.txt"
  fi
done
