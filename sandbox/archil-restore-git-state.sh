#!/bin/bash
# Restores git state saved by archil-git-sync.sh from the persist volume.
# This is used on machine boot/handoff to recover in-progress changes.
set -euo pipefail

PERSIST="${ARCHIL_PERSIST_DIR:-/mnt/persist}"
REPO_DIR="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
PATCH_FILE="${PERSIST}/uncommitted-changes.patch"
UNTRACKED_ARCHIVE="${PERSIST}/untracked-files.tar.gz"
UNTRACKED_LIST="${PERSIST}/untracked-files.txt"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "[archil-restore] Repo missing or not a git repo, skipping restore: ${REPO_DIR}"
  exit 0
fi

if [[ -f "${PATCH_FILE}" ]]; then
  echo "[archil-restore] Applying tracked changes patch"
  git -C "${REPO_DIR}" apply --allow-empty "${PATCH_FILE}"
fi

if [[ -f "${UNTRACKED_ARCHIVE}" ]]; then
  echo "[archil-restore] Restoring untracked file archive"
  tar -C "${REPO_DIR}" -xzf "${UNTRACKED_ARCHIVE}"
elif [[ -f "${UNTRACKED_LIST}" ]]; then
  echo "[archil-restore] Found untracked file list without archive; skipping untracked restore"
fi
