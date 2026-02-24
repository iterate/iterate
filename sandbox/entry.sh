#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Docker provider: sync host repo into container
# In local development this behaviour can be toggled on and off in the os UI and is
# implemented in sandbox/providers/docker/provider.ts
if [[ -n "${DOCKER_HOST_SYNC_ENABLED:-}" ]]; then
  bash "${ITERATE_REPO}/sandbox/providers/docker/sync-repo-from-host.sh"
fi

# This is primarily useful for tests of the docker provider,
# where we want to exec commands in the container _after_ the initial sync.
touch /tmp/reached-entrypoint

if [[ "${DOCKER_DEFAULT_SERVICE_TRANSPORT:-port-map}" == "cloudflare-tunnel" ]]; then
  bash "${ITERATE_REPO}/sandbox/providers/docker/start-cloudflare-tunnels.sh" >/tmp/cloudflare-tunnels-bootstrap.log 2>&1 &
fi

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


# Mount Archil persistent volume at ~/src if configured.
# Env vars come from the sandbox provider or ~/.iterate/.env.
if [[ -f /home/iterate/.iterate/.env ]]; then
  set +e
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' /home/iterate/.iterate/.env)"
  set -e
fi

if [[ -n "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[entry] Mounting Archil disk ${ARCHIL_DISK_NAME} at ~/src"
  export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN:-}"
  if sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" /home/iterate/src \
       --region "${ARCHIL_REGION:-aws-us-east-1}" 2>&1; then
    sudo chown -R iterate:iterate /home/iterate/src
    echo "[entry] Archil mounted"
  else
    echo "[entry] WARNING: Archil mount failed, continuing without persistence"
  fi
  trap 'sudo archil unmount /home/iterate/src 2>/dev/null || true' EXIT
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
