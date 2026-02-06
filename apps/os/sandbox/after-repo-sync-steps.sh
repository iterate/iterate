#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

if [[ -f "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh" ]]; then
  echo "[entry] Syncing home-skeleton"
  bash "${ITERATE_REPO}/apps/os/sandbox/sync-home-skeleton.sh"
fi

# Rebuild daemon frontend after repo sync so dist/ matches source.
echo "[entry] Rebuilding daemon frontend after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm vite build)

# Run database migrations after repo sync so schema matches migrations.
echo "[entry] Running database migrations after sync"
(cd "${ITERATE_REPO}/apps/daemon" && pnpm db:migrate)
