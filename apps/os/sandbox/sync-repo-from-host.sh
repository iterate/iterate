#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

HOST_GITDIR="${LOCAL_DOCKER_GIT_DIR:-${LOCAL_DOCKER_GIT_GITDIR:-/host/gitdir}}"
HOST_COMMONDIR="${LOCAL_DOCKER_COMMON_DIR:-${LOCAL_DOCKER_GIT_COMMON_DIR:-/host/commondir}}"

if [[ ! -d "/host/repo-checkout" ]]; then
  echo "[entry] /host/repo-checkout not found. Ensure host repo mount is configured."
  exit 1
fi

echo "[entry] Syncing repo from /host/repo-checkout -> ${ITERATE_REPO}"
rsync -a --delete \
  --filter=':- .gitignore' \
  --filter=':- .git/info/exclude' \
  --exclude='.git' \
  --exclude='node_modules' \
  "/host/repo-checkout/" "${ITERATE_REPO}/"

if [[ -d "${HOST_COMMONDIR}" ]]; then
  echo "[entry] Syncing commondir from ${HOST_COMMONDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"
  rsync -a --delete \
    --no-owner --no-group --no-perms \
    "${HOST_COMMONDIR}/" "${ITERATE_REPO}/.git/"
fi

if [[ -d "${HOST_GITDIR}" ]]; then
  if [[ -e "${ITERATE_REPO}/.git" && ! -d "${ITERATE_REPO}/.git" ]]; then
      rm -f "${ITERATE_REPO}/.git"
  fi

  echo "[entry] Syncing gitdir from ${HOST_GITDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"
  rsync -a \
    --no-owner --no-group --no-perms \
    "${HOST_GITDIR}/" "${ITERATE_REPO}/.git/"
fi

# Flatten worktree metadata copied from host paths.
if [[ -f "${ITERATE_REPO}/.git/commondir" || -f "${ITERATE_REPO}/.git/gitdir" ]]; then
  rm -f "${ITERATE_REPO}/.git/commondir" "${ITERATE_REPO}/.git/gitdir"
fi

if [[ -f "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh" ]]; then
  echo "[entry] Syncing home-skeleton"
  bash "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh"
fi
