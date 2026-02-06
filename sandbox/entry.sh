#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Docker provider: sync host repo into container
# In local development this behaviour can be toggled on and off in the os UI and is
# implemented in sandbox/providers/docker/provider.ts
if [[ -n "${DOCKER_SYNC_FROM_HOST_REPO:-}" ]]; then
  bash "${ITERATE_REPO}/sandbox/providers/docker/sync-repo-from-host.sh"
fi

# This is primarily useful for tests of the docker provider,
# where we want to exec commands in the container _after_ the initial sync.
touch /tmp/reached-entrypoint

# Allow overriding entrypoint args in two ways:
# 1) Positional args (normal Docker/CMD path), e.g.:
#    docker run --rm -it iterate-sandbox:local /bin/bash
# 2) SANDBOX_ENTRY_ARGS env var (tab-delimited args) for sandbox providers like Daytona,
#    where sandbox creation supports env vars but does not support startup args.
if [[ $# -gt 0 ]]; then
  exec "$@"
fi

if [[ -n "${SANDBOX_ENTRY_ARGS:-}" ]]; then
  IFS=$'\t' read -r -a env_entry_args <<< "${SANDBOX_ENTRY_ARGS}"
  if [[ ${#env_entry_args[@]} -gt 0 ]]; then
    exec "${env_entry_args[@]}"
  fi
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
  init -c "$ITERATE_REPO/sandbox/pidnap.config.ts" > "$CONSOLE_FIFO" 2>&1
