#!/bin/bash
# TODO: This script is still a bit messy; the main entrypoint in
# apps/os/sandbox/entry.sh is now clean, but this sync helper could use a refactor.
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

HOST_GITDIR="${LOCAL_DOCKER_GIT_DIR:-${LOCAL_DOCKER_GIT_GITDIR:-/host/gitdir}}"
HOST_COMMONDIR="${LOCAL_DOCKER_COMMON_DIR:-${LOCAL_DOCKER_GIT_COMMON_DIR:-/host/commondir}}"

if [[ ! -d "/host/repo-checkout" ]]; then
  echo "[entry] /host/repo-checkout not found. Ensure host repo mount is configured."
  exit 1
fi

echo "[entry] Syncing repo from /host/repo-checkout -> ${ITERATE_REPO}"
set +e
rsync -a --delete --force \
  --filter=':- .gitignore' \
  --filter=':- .git/info/exclude' \
  --exclude='.git' \
  --exclude='node_modules' \
  "/host/repo-checkout/" "${ITERATE_REPO}/"
repo_sync_status=$?
set -e
# rsync returns 24 when files vanish mid-transfer (common during parallel builds/tests).
# We tolerate that case to avoid killing the container during startup, but still fail
# on any other non-zero exit code so real sync errors surface.
if [[ $repo_sync_status -ne 0 && $repo_sync_status -ne 23 && $repo_sync_status -ne 24 ]]; then
  exit $repo_sync_status
fi

if [[ -d "${HOST_COMMONDIR}" ]]; then
  echo "[entry] Syncing commondir from ${HOST_COMMONDIR} -> ${ITERATE_REPO}/.git"
  mkdir -p "${ITERATE_REPO}/.git"
  # Note: no --delete here - we just overlay, then gitdir overlays on top
  rsync -a --force \
    --no-owner --no-group --no-perms \
    "${HOST_COMMONDIR}/" "${ITERATE_REPO}/.git/"
  # Same rsync semantics as above: 24 is acceptable, anything else is fatal.
  commondir_sync_status=$?
  if [[ $commondir_sync_status -ne 0 && $commondir_sync_status -ne 24 ]]; then
    exit $commondir_sync_status
  fi
fi

if [[ -d "${HOST_GITDIR}" ]]; then
  if [[ -e "${ITERATE_REPO}/.git" && ! -d "${ITERATE_REPO}/.git" ]]; then
      rm -f "${ITERATE_REPO}/.git"
  fi

  echo "[entry] Syncing gitdir from ${HOST_GITDIR} -> ${ITERATE_REPO}/.git"
  set +e
  echo "[entry] DEBUG: HOST_GITDIR contents:"
  ls -la "${HOST_GITDIR}/" | head -10 || true
  echo "[entry] DEBUG: HOST_GITDIR/HEAD: $(cat ${HOST_GITDIR}/HEAD 2>/dev/null || echo 'NO HEAD')"
  echo "[entry] DEBUG: .git/HEAD before: $(cat ${ITERATE_REPO}/.git/HEAD 2>/dev/null || echo 'NO HEAD')"
  mkdir -p "${ITERATE_REPO}/.git"
  
  # Try direct cp first to see if that works
  echo "[entry] DEBUG: copying HEAD directly with cp..."
  echo "[entry] DEBUG: source file exists: $(test -f "${HOST_GITDIR}/HEAD" && echo yes || echo no)"
  echo "[entry] DEBUG: dest dir writable: $(test -w "${ITERATE_REPO}/.git" && echo yes || echo no)"
  cp -v "${HOST_GITDIR}/HEAD" "${ITERATE_REPO}/.git/HEAD"
  CP_EXIT=$?
  echo "[entry] DEBUG: cp exit code: $CP_EXIT"
  echo "[entry] DEBUG: .git/HEAD after cp: $(cat ${ITERATE_REPO}/.git/HEAD 2>/dev/null || echo 'NO HEAD')"
  
  # Now rsync the rest
  echo "[entry] DEBUG: running rsync..."
  rsync -av \
    --no-owner --no-group --no-perms \
    "${HOST_GITDIR}/" "${ITERATE_REPO}/.git/" 2>&1
  # Same rsync semantics as above: 24 is acceptable, anything else is fatal.
  gitdir_sync_status=$?
  echo "[entry] DEBUG: rsync exit code: $gitdir_sync_status"
  echo "[entry] DEBUG: .git/HEAD after rsync: $(cat ${ITERATE_REPO}/.git/HEAD 2>/dev/null || echo 'NO HEAD')"
  set -e
  if [[ $gitdir_sync_status -ne 0 && $gitdir_sync_status -ne 24 ]]; then
    exit $gitdir_sync_status
  fi
fi

# Flatten worktree metadata copied from host paths.
if [[ -f "${ITERATE_REPO}/.git/commondir" || -f "${ITERATE_REPO}/.git/gitdir" ]]; then
  rm -f "${ITERATE_REPO}/.git/commondir" "${ITERATE_REPO}/.git/gitdir"
fi

if [[ -f "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh" ]]; then
  echo "[entry] Syncing home-skeleton"
  bash "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh"
fi

echo "[entry] sync-repo-from-host.sh COMPLETED SUCCESSFULLY"
