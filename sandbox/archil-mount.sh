#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
#
# Mounts archil at /mnt/persist (NOT over ~). The Docker image already has the
# repo + node_modules baked in, so boot is instant.
#
# Persisted state:
#   - ~/persisted → /mnt/persist/persisted (user files that survive reprovisioning)
#   - OpenCode sqlite snapshot (restored on boot, synced periodically by archil-opencode-sync)
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST="/mnt/persist"

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "${HOME_DIR}/.iterate/.env" ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "${HOME_DIR}/.iterate/.env")"
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
  touch /tmp/archil-repo-ready
  exec sleep infinity
fi

# Already mounted? Sleep to keep process alive.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted"
  touch /tmp/archil-repo-ready
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

  # Create ~/persisted symlink → /mnt/persist/persisted
  mkdir -p "${PERSIST}/persisted"
  sudo chown iterate:iterate "${PERSIST}/persisted"
  ln -sfn "${PERSIST}/persisted" "${HOME_DIR}/persisted"
  echo "[archil] ~/persisted → ${PERSIST}/persisted"

  # Restore opencode sqlite snapshot from persist volume.
  # Keep the live sqlite on local disk (not on archil mount) to avoid
  # "SQLiteError: file is not a database" on network-backed fs.
  OPENCODE_LOCAL_DIR="${HOME_DIR}/.local/share/opencode"
  OPENCODE_SNAPSHOT_DB="${PERSIST}/.opencode-snapshot/opencode.db"

  mkdir -p "${OPENCODE_LOCAL_DIR}"
  if [[ -f "${OPENCODE_SNAPSHOT_DB}" ]]; then
    echo "[archil] Restoring opencode sqlite snapshot"
    cp -f "${OPENCODE_SNAPSHOT_DB}" "${OPENCODE_LOCAL_DIR}/opencode.db"
  fi

  # Signal that the repo is ready (it's baked into the image, no clone needed)
  touch /tmp/archil-repo-ready
  echo "[archil] Setup complete, repo ready"
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
