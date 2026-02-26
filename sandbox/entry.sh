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

# Archil persistent home: prepare ~ for archil mount.
# When archil is configured, we need ~ to be empty so archil can mount over it.
# The archil-mount pidnap process will mount archil at ~ and seed from /opt/home-base
# on first boot. The iterate repo is copied to /opt/iterate-repo so pidnap can
# still start (since ~/src/... will be briefly unavailable during mount).
if [[ -n "${ARCHIL_DISK_NAME:-}" ]] && [[ ! -d /opt/home-base ]]; then
  echo "[entry] Preparing home dir for archil persistence"
  # Move iterate repo to /opt first — pidnap needs it while ~ is empty/mounting.
  # mv is instant (same filesystem), unlike cp which takes minutes for node_modules.
  sudo mv "${ITERATE_REPO}" /opt/iterate-repo
  # Save home dir (minus the repo) as seed template for first-boot archil seeding.
  # The repo dir is now gone from ~, so this only copies dotfiles/configs (~fast).
  sudo cp -a /home/iterate /opt/home-base
  # Clear home dir contents so archil can mount cleanly
  sudo find /home/iterate -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  # Update ITERATE_REPO to point to the /opt copy for this boot
  ITERATE_REPO="/opt/iterate-repo"
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
