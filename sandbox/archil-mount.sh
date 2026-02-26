#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~ so the entire home directory
# persists across machine reprovisioning.
#
# First boot: seeds the archil disk from /opt/home-base (image defaults).
# Subsequent boots: archil already has the home dir contents.
#
# Env vars (from ~/.iterate/.env or /opt/home-base/.iterate/.env):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

MOUNT_POINT="/home/iterate"

# Source env vars — home may be empty (cleared by entry.sh), so check /opt/home-base too
for env_file in /home/iterate/.iterate/.env /opt/home-base/.iterate/.env; do
  if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "$env_file" ]]; then
    eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "$env_file")"
  fi
done

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
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

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${MOUNT_POINT} (region: ${ARCHIL_CLI_REGION})"

# Post-mount tasks run in background since --no-fork blocks the main thread:
# 1. Seed from /opt/home-base on first boot (empty disk)
# 2. Fix ownership so iterate user can write
(
  while ! grep -q "archil" /proc/mounts 2>/dev/null; do sleep 1; done

  # Seed on first boot: if the disk has no .bashrc, it's empty — copy image defaults
  if [[ -d /opt/home-base ]] && [[ ! -f "${MOUNT_POINT}/.bashrc" ]]; then
    echo "[archil] First boot — seeding home dir from image defaults"
    sudo cp -a /opt/home-base/. "${MOUNT_POINT}/"
    echo "[archil] Seed complete"
  fi

  sudo chown iterate:iterate "${MOUNT_POINT}"
  echo "[archil] Mount ready"
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
