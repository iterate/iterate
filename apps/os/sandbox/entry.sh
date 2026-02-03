#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Local Docker: sync host repo into container
# In local development this behaviour can be toggled on and off inthe os UI and is
# implemented in providers/local-docker.ts
if [[ -n "${LOCAL_DOCKER_SYNC_FROM_HOST_REPO:-}" ]]; then
  "${ITERATE_REPO}/apps/os/sandbox/sync-repo-from-host.sh"
fi

# Allow interactive shell in a fresh container - e.g.:
# docker run --rm -it ghcr.io/iterate/sandbox:local /bin/bash
if [[ $# -gt 0 ]]; then
  exec "$@"
fi

exec tini -sg -- \
  # pidnap watches /home/iterate/.iterate/.env itself, so avoid tsx --env-file-if-exists
  tsx --watch \
  "$ITERATE_REPO/packages/pidnap/src/cli.ts" \
  init -c "$ITERATE_REPO/apps/os/sandbox/pidnap.config.ts"