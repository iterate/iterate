#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
HOST_REPO_CHECKOUT="${HOST_REPO_CHECKOUT:-/host/repo-checkout}"
HOST_GITDIR="${HOST_GITDIR:-/host/gitdir}"
HOST_COMMONDIR="${HOST_COMMONDIR:-/host/commondir}"

if [[ -d "${HOST_REPO_CHECKOUT}" ]]; then
  echo "[entry] Syncing repo from ${HOST_REPO_CHECKOUT} -> ${ITERATE_REPO}"
  rsync -a --delete \
    --filter=':- .gitignore' \
    --filter=':- .git/info/exclude' \
    --exclude='.git' \
    --exclude='node_modules' \
    "${HOST_REPO_CHECKOUT}/" "${ITERATE_REPO}/"

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

  if [[ -f "${ITERATE_REPO}/apps/os/sandbox/sync-home.sh" ]]; then
    echo "[entry] Syncing home-skeleton"
    bash "${ITERATE_REPO}/apps/os/sandbox/sync-home.sh"
  fi
fi

if [[ $# -gt 0 ]]; then
  exec "$@"
fi

exec tini -sg -- pnpm exec tsx --env-file-if-exists ~/.iterate/.env --watch "${ITERATE_REPO}/packages/pidnap/src/cli.ts" init -c "${ITERATE_REPO}/apps/os/sandbox/pidnap.config.ts"
