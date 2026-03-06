#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
#
# Mounts archil at /mnt/persist, then symlinks directories so that
# applications write directly to the archil volume. Archil's NVMe-cached
# FUSE mount handles durability — no snapshot/sync loops needed.
#
# Persisted directories:
#   ~/.local/share → /mnt/persist/.local/share  (opencode DB, session storage)
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST="/mnt/persist"

setup_symlinks() {
  sudo mkdir -p "${PERSIST}/.local/share"
  sudo chown -R iterate:iterate "${PERSIST}/.local"

  rm -rf "${HOME_DIR}/.local/share"
  mkdir -p "${HOME_DIR}/.local"
  ln -sfn "${PERSIST}/.local/share" "${HOME_DIR}/.local/share"
  echo "[archil] ~/.local/share → ${PERSIST}/.local/share"

  touch /tmp/persistence-ready
  echo "[persist] Setup complete, persistence ready"
}

setup_local_persistence() {
  sudo mkdir -p "${PERSIST}"
  setup_symlinks
  exec sleep infinity
}

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "${HOME_DIR}/.iterate/.env" ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "${HOME_DIR}/.iterate/.env")"
fi

PERSISTENCE_MODE="${ITERATE_PERSISTENCE_MODE:-auto}"

if [[ "${PERSISTENCE_MODE}" == "local" ]]; then
  echo "[persist] ITERATE_PERSISTENCE_MODE=local"
  setup_local_persistence
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[persist] No ARCHIL_DISK_NAME set, using local persist dir"
  setup_local_persistence
fi

if [[ ! -e /dev/fuse ]]; then
  if [[ "${PERSISTENCE_MODE}" == "archil" ]]; then
    echo "[persist] ITERATE_PERSISTENCE_MODE=archil but /dev/fuse unavailable"
    exit 1
  fi
  echo "[persist] /dev/fuse unavailable, using local persist dir"
  setup_local_persistence
fi

# Already mounted? Just set up symlinks and sleep.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted"
  setup_symlinks
  exec sleep infinity
fi

# Archil CLI expects provider-prefixed region (e.g. aws-us-east-1)
ARCHIL_CLI_REGION="${ARCHIL_REGION:-us-east-1}"
case "${ARCHIL_CLI_REGION}" in
  aws-*|gcp-*) ;; # already prefixed
  *) ARCHIL_CLI_REGION="aws-${ARCHIL_CLI_REGION}" ;;
esac

export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN:-}"

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${PERSIST} (region: ${ARCHIL_CLI_REGION})"
sudo mkdir -p "$PERSIST"

# Post-mount setup runs in background since --no-fork blocks the main thread.
(
  set +e
  trap 'echo "[archil] Background task error on line $LINENO: $BASH_COMMAND (exit $?)"' ERR

  # Wait for archil FUSE mount
  while ! grep -q "$PERSIST" /proc/mounts 2>/dev/null; do sleep 1; done
  echo "[archil] Archil mounted at ${PERSIST}"

  sudo chown iterate:iterate "$PERSIST"

  # Create persistent directories on the volume (sudo needed — FUSE mount is root-owned)
  # Symlink persistent directories and signal ready.
  # Everything under ~/.local/share is persisted: opencode sessions,
  # daemon DB, events-service DB, and anything else apps put here (XDG convention).
  # mitmproxy is installed to /opt/mitmproxy (not ~/.local/share) to avoid conflicts.
  setup_symlinks
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
