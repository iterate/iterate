#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
GIT_TARGET="${LOCAL_DOCKER_SYNC_FROM_GIT_TARGET:-}"

if [[ -z "${GIT_TARGET}" ]]; then
  echo "[entry] LOCAL_DOCKER_SYNC_FROM_GIT_TARGET is required (format: <remote>:<ref>)"
  exit 1
fi

if [[ "${GIT_TARGET}" != *:* ]]; then
  echo "[entry] Invalid LOCAL_DOCKER_SYNC_FROM_GIT_TARGET='${GIT_TARGET}'"
  echo "[entry] Expected format: <remote>:<ref> (example: origin:main)"
  exit 1
fi

GIT_REMOTE="${GIT_TARGET%%:*}"
GIT_REF="${GIT_TARGET#*:}"

if [[ -z "${GIT_REMOTE}" || -z "${GIT_REF}" ]]; then
  echo "[entry] Invalid LOCAL_DOCKER_SYNC_FROM_GIT_TARGET='${GIT_TARGET}'"
  echo "[entry] Expected format: <remote>:<ref> (example: origin:main)"
  exit 1
fi

if ! git -C "${ITERATE_REPO}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "[entry] ${ITERATE_REPO} is not a git repo"
  exit 1
fi

if ! git -C "${ITERATE_REPO}" remote get-url "${GIT_REMOTE}" >/dev/null 2>&1; then
  echo "[entry] Git remote '${GIT_REMOTE}' not found in ${ITERATE_REPO}"
  exit 1
fi

echo "[entry] Syncing repo from git target ${GIT_REMOTE}:${GIT_REF}"
git -C "${ITERATE_REPO}" fetch --prune "${GIT_REMOTE}" "${GIT_REF}"
SYNC_COMMIT="$(git -C "${ITERATE_REPO}" rev-parse FETCH_HEAD)"
echo "[entry] Checking out ${SYNC_COMMIT}"
git -C "${ITERATE_REPO}" checkout --detach --force "${SYNC_COMMIT}"

if [[ -f "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh" ]]; then
  echo "[entry] Syncing home-skeleton"
  bash "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh"
fi

# Rebuild daemon frontend after sync so dist/ matches fetched source.
echo "[entry] Rebuilding daemon frontend after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm vite build)

# Run database migrations after sync so schema matches fetched migrations.
echo "[entry] Running database migrations after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm db:migrate)
