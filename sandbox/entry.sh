#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

# Resolve sandbox dir: /opt/sandbox always exists (copied at build time).
# After repo extraction or Docker sync, $ITERATE_REPO/sandbox also exists.
SANDBOX_DIR="/opt/sandbox"

# Docker provider: sync host repo into container
# In local development this behaviour can be toggled on and off in the os UI and is
# implemented in sandbox/providers/docker/provider.ts
if [[ -n "${DOCKER_HOST_SYNC_ENABLED:-}" ]]; then
  bash "${SANDBOX_DIR}/providers/docker/sync-repo-from-host.sh"
fi

# This is primarily useful for tests of the docker provider,
# where we want to exec commands in the container _after_ the initial sync.
touch /tmp/reached-entrypoint

if [[ "${DOCKER_DEFAULT_SERVICE_TRANSPORT:-port-map}" == "cloudflare-tunnel" ]]; then
  bash "${SANDBOX_DIR}/providers/docker/start-cloudflare-tunnels.sh" >/tmp/cloudflare-tunnels-bootstrap.log 2>&1 &
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

# Repo bootstrap: the Dockerfile packages the full ~ (repo + dotfiles + tools)
# into /opt/home.tar and removes the repo from ~.
# - Docker provider: host sync already populated the repo, no extraction needed.
# - Archil mode: archil-mount.sh extracts the tarball after mounting the persistent disk.
#   Pidnap starts from /opt/sandbox (copied at build time) before archil is ready.
# - Non-archil Fly: extract here so the repo is available immediately.
if [[ -z "${DOCKER_HOST_SYNC_ENABLED:-}" ]] && [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  if [[ ! -d "${ITERATE_REPO}/sandbox" ]] && [[ -f /opt/home.tar.gz ]]; then
    echo "[entry] Extracting home tarball (non-archil mode)"
    tar xzf /opt/home.tar.gz -C /home/iterate
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

# Pidnap config: use /opt/sandbox copy (always available, doesn't depend on archil).
# Pidnap CLI: use the repo copy if available, otherwise extract just pidnap from tarball.
PIDNAP_CONFIG="/opt/sandbox/pidnap.config.ts"
PIDNAP_CLI="${ITERATE_REPO}/packages/pidnap/src/cli.ts"
if [[ ! -f "$PIDNAP_CLI" ]] && [[ -f /opt/home.tar.gz ]]; then
  echo "[entry] Extracting pidnap from tarball"
  tar xzf /opt/home.tar.gz -C /home/iterate \
    --include='./src/github.com/iterate/iterate/packages/pidnap/*' \
    --include='./src/github.com/iterate/iterate/node_modules/pidnap' \
    --include='./src/github.com/iterate/iterate/node_modules/.pnpm/pidnap*' \
    --include='./src/github.com/iterate/iterate/package.json'
fi

# pidnap watches /home/iterate/.iterate/.env itself, so avoid tsx --env-file-if-exists
# Pidnap take the wheel - redirect stdout/stderr to FIFO
exec tini -sg -- \
  tsx --watch \
  "$PIDNAP_CLI" \
  init -c "$PIDNAP_CONFIG" > "$CONSOLE_FIFO" 2>&1
