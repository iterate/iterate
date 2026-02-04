#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Local Docker: sync host repo into container
# In local development this behaviour can be toggled on and off inthe os UI and is
# implemented in providers/local-docker.ts
if [[ -n "${LOCAL_DOCKER_SYNC_FROM_HOST_REPO:-}" ]]; then
  sync_script="${ITERATE_REPO}/apps/os/sandbox/sync-repo-from-host.sh"
  sync_tmp="/tmp/sync-repo-from-host.sh"
  cp "$sync_script" "$sync_tmp"
  chmod +x "$sync_tmp"
  bash "$sync_tmp"
fi

# This is primarily useful for tests of the local-docker provider,
# where we want to exec commands in the container _after_ the initial sync.
# A bit weird to have this here so we might move it to a local docker specific
# place later.
touch /tmp/reached-entrypoint

# Allow interactive shell in a fresh container - e.g.:
# docker run --rm -it ghcr.io/iterate/sandbox:local /bin/bash
if [[ $# -gt 0 ]]; then
  exec "$@"
fi


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
