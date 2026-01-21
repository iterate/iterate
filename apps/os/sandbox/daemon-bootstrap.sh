#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
LOCAL_SYNC_SCRIPT="/home/iterate/.local/bin/local-docker-sync.sh"

if { [ "${ITERATE_MACHINE_PROVIDER:-}" = "local-docker" ] || [ -d "/local-iterate-repo" ]; } && \
  [ -x "$LOCAL_SYNC_SCRIPT" ]; then
  "$LOCAL_SYNC_SCRIPT"
fi

cd "$ITERATE_REPO/apps/daemon"
pnpm db:migrate
exec tsx server.ts --auto-run-bootstrap
