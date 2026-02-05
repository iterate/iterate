#!/bin/bash
# TODO: This script is still a bit messy; the main entrypoint in
# sandbox/entry.sh is now clean, but this sync helper could use a refactor.
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

HOST_GITDIR="${DOCKER_GIT_GITDIR:-/host/gitdir}"
HOST_COMMONDIR="${DOCKER_GIT_COMMON_DIR:-/host/commondir}"

if [[ ! -d "/host/repo-checkout" ]]; then
  echo "[entry] /host/repo-checkout not found. Ensure host repo mount is configured."
  exit 1
fi

echo "[entry] Syncing repo from /host/repo-checkout -> ${ITERATE_REPO}"
rsync -a --delete --force \
  --filter=':- .gitignore' \
  --filter=':- .git/info/exclude' \
  --exclude='.git' \
  --exclude='node_modules' \
  "/host/repo-checkout/" "${ITERATE_REPO}/"

if [[ -d "${HOST_COMMONDIR}" ]]; then
  echo "[entry] Syncing commondir from ${HOST_COMMONDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"
  # Note: no --delete here - we just overlay, then gitdir overlays on top
  rsync -a --force \
    --no-owner --no-group --no-perms \
    "${HOST_COMMONDIR}/" "${ITERATE_REPO}/.git/"
fi

if [[ -d "${HOST_GITDIR}" ]]; then
  if [[ -e "${ITERATE_REPO}/.git" && ! -d "${ITERATE_REPO}/.git" ]]; then
      rm -f "${ITERATE_REPO}/.git"
  fi

  echo "[entry] Syncing gitdir from ${HOST_GITDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"

  rsync -a --force \
    --no-owner --no-group --no-perms \
    "${HOST_GITDIR}/" "${ITERATE_REPO}/.git/"
fi

# Flatten worktree metadata copied from host paths.
if [[ -f "${ITERATE_REPO}/.git/commondir" || -f "${ITERATE_REPO}/.git/gitdir" ]]; then
  rm -f "${ITERATE_REPO}/.git/commondir" "${ITERATE_REPO}/.git/gitdir"
fi

if [[ -f "${ITERATE_REPO}/sandbox/sync-home-skeleton.sh" ]]; then
  echo "[entry] Syncing home-skeleton"
  bash "${ITERATE_REPO}/sandbox/sync-home-skeleton.sh"
fi

# Rebuild daemon frontend after sync to ensure the build matches synced source.
# The Docker image contains a pre-built dist/, but when syncing from host the source
# files may have changed while dist/ is preserved (it's gitignored).
echo "[entry] Rebuilding daemon frontend after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm vite build)

# Run database migrations after sync to ensure schema matches synced migration files.
# The Docker image contains a pre-migrated db.sqlite, but when syncing from host the
# drizzle/ migration files may have changed while db.sqlite is preserved (it's gitignored).
echo "[entry] Running database migrations after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm db:migrate)
