#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Local Docker: sync host repo into container
# In local development this behaviour can be toggled on and off inthe os UI and is
# implemented in providers/local-docker.ts
if [[ -n "${LOCAL_DOCKER_SYNC_FROM_HOST_REPO:-}" ]]; then
  bash "${ITERATE_REPO}/apps/os/sandbox/sync-repo-from-host.sh"
fi

# Allow interactive shell in a fresh container - e.g.:
# docker run --rm -it ghcr.io/iterate/sandbox:local /bin/bash
if [[ $# -gt 0 ]]; then
  exec "$@"
fi

# Signal readiness for tests and stuff
touch /tmp/.iterate-sandbox-ready

# Setup console logging via named pipe (FIFO)
# Using a FIFO keeps pidnap as direct child of tini for proper signal handling
CONSOLE_LOG="/var/log/pidnap/console"
CONSOLE_FIFO="/tmp/pidnap-console-fifo"
mkdir -p "$(dirname "$CONSOLE_LOG")"
rm -f "$CONSOLE_FIFO"
mkfifo "$CONSOLE_FIFO"

# Background process reads from FIFO and writes to both file and stdout
tee -a "$CONSOLE_LOG" < "$CONSOLE_FIFO" &

# pidnap watches /home/iterate/.iterate/.env itself, so avoid tsx --env-file-if-exists
# Pidnap take the wheel - redirect stdout/stderr to FIFO
exec tini -sg -- \
  tsx --watch \
  "$ITERATE_REPO/packages/pidnap/src/cli.ts" \
  init -c "$ITERATE_REPO/apps/os/sandbox/pidnap.config.ts" > "$CONSOLE_FIFO" 2>&1
