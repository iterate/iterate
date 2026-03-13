#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
HOST_REPO_CHECKOUT="${DOCKER_HOST_REPO_CHECKOUT:-/host/repo-checkout}"
HOST_GITDIR="${DOCKER_HOST_GIT_DIR:-/host/gitdir}"
HOST_COMMONDIR="${DOCKER_HOST_GIT_COMMON_DIR:-/host/commondir}"
PNPM_STORE_DIR="${npm_config_store_dir:-/home/iterate/.pnpm-store}"

if [[ ! -d "${HOST_REPO_CHECKOUT}" ]]; then
  echo "[entry] ${HOST_REPO_CHECKOUT} not found. Ensure host repo mount is configured."
  exit 1
fi

echo "[entry] Syncing repo from ${HOST_REPO_CHECKOUT} -> ${ITERATE_REPO}"
rsync -a --delete --force \
  --filter=':- .gitignore' \
  --filter=':- .git/info/exclude' \
  --exclude='.git' \
  --exclude='node_modules' \
  "${HOST_REPO_CHECKOUT}/" "${ITERATE_REPO}/"

if [[ -d "${HOST_COMMONDIR}" ]]; then
  echo "[entry] Syncing commondir from ${HOST_COMMONDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"
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

if [[ -f "${ITERATE_REPO}/.git/commondir" || -f "${ITERATE_REPO}/.git/gitdir" ]]; then
  rm -f "${ITERATE_REPO}/.git/commondir" "${ITERATE_REPO}/.git/gitdir"
fi

(cd "${ITERATE_REPO}" && CI=true npm_config_store_dir="${PNPM_STORE_DIR}" pnpm install --prod --frozen-lockfile --prefer-offline --ignore-scripts)
