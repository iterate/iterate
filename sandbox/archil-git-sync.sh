#!/bin/bash
# Periodically saves uncommitted git changes to the archil persist volume.
# This ensures work-in-progress survives machine reprovisioning.
#
# Runs as a background process managed by pidnap.
# Saves a patch file to /mnt/persist/uncommitted-changes.patch every 30 seconds.
set -euo pipefail

PERSIST="${ARCHIL_PERSIST_DIR:-/mnt/persist}"
REPO_DIR="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
PATCH_FILE="${PERSIST}/uncommitted-changes.patch"
UNTRACKED_LIST_FILE="${PERSIST}/untracked-files.txt"
UNTRACKED_ARCHIVE_FILE="${PERSIST}/untracked-files.tar.gz"
SYNC_INTERVAL_SECONDS="${ARCHIL_GIT_SYNC_INTERVAL_SECONDS:-30}"
RUN_ONCE="${ARCHIL_GIT_SYNC_RUN_ONCE:-false}"
SKIP_MOUNT_WAIT="${ARCHIL_GIT_SYNC_SKIP_MOUNT_WAIT:-false}"

echo "[git-sync] Starting git change sync (repo: ${REPO_DIR}, persist: ${PERSIST})"

if [[ "${SKIP_MOUNT_WAIT}" != "true" ]]; then
  # Wait for archil to mount
  while ! grep -q "$PERSIST" /proc/mounts 2>/dev/null; do
    sleep 5
  done
  echo "[git-sync] Archil mounted, starting periodic sync"
fi

sync_once() {
  # Skip if repo doesn't exist or isn't a git repo
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    return
  fi

  cd "$REPO_DIR"

  # Generate a diff of all tracked uncommitted changes (staged + unstaged)
  DIFF=$(git diff HEAD 2>/dev/null || true)
  UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)

  if [[ -n "$DIFF" ]] || [[ -n "$UNTRACKED" ]]; then
    # Save tracked changes patch
    git diff HEAD > "$PATCH_FILE" 2>/dev/null || true

    # Save untracked file list + archive so next machine can restore them.
    if [[ -n "$UNTRACKED" ]]; then
      echo "$UNTRACKED" > "${UNTRACKED_LIST_FILE}"
      tar -C "$REPO_DIR" -czf "${UNTRACKED_ARCHIVE_FILE}" -T "${UNTRACKED_LIST_FILE}" 2>/dev/null || true
    else
      rm -f "${UNTRACKED_LIST_FILE}" "${UNTRACKED_ARCHIVE_FILE}"
    fi
  else
    # No changes, clean up old artifacts
    rm -f "$PATCH_FILE" "${UNTRACKED_LIST_FILE}" "${UNTRACKED_ARCHIVE_FILE}"
  fi
}

while true; do
  sync_once

  if [[ "${RUN_ONCE}" == "true" ]]; then
    exit 0
  fi

  sleep "${SYNC_INTERVAL_SECONDS}"
done
