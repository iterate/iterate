#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~/workspace so user files
# persist across machine reprovisioning.
#
# Env vars (from ~/.iterate/.env or machine env):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

MOUNT_POINT="/home/iterate/workspace"

# Source env vars from .iterate/.env if not already set
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f /home/iterate/.iterate/.env ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' /home/iterate/.iterate/.env)"
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
  # Sleep forever so pidnap doesn't restart us in a loop
  exec sleep infinity
fi

# Already mounted? Sleep to keep process alive.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted at ${MOUNT_POINT}"
  exec sleep infinity
fi

# Archil CLI expects provider-prefixed region (e.g. aws-us-east-1)
ARCHIL_CLI_REGION="${ARCHIL_REGION:-us-east-1}"
case "${ARCHIL_CLI_REGION}" in
  aws-*|gcp-*) ;; # already prefixed
  *) ARCHIL_CLI_REGION="aws-${ARCHIL_CLI_REGION}" ;;
esac

export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN:-}"

# Ensure mount point exists
mkdir -p "${MOUNT_POINT}"

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${MOUNT_POINT} (region: ${ARCHIL_CLI_REGION})"

# Fix ownership after mount: archil mounts as root, but the iterate user needs write access.
# Run in background since --no-fork blocks the main thread.
(
  while ! grep -q "archil" /proc/mounts 2>/dev/null; do sleep 1; done
  sudo chown iterate:iterate "${MOUNT_POINT}"
  echo "[archil] Mount ready — ownership set to iterate:iterate"
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
# --log-dir: log to file for debugging.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${MOUNT_POINT}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
