#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~ so the entire home directory
# persists across machine reprovisioning.
#
# First boot: extracts /opt/home.tar (baked into image) into the empty archil disk.
# Subsequent boots: archil already has everything, extraction is skipped.
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

MOUNT_POINT="/home/iterate"

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f /home/iterate/.iterate/.env ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' /home/iterate/.iterate/.env)"
fi

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
# 1. Seed from /opt/home.tar on first boot (empty disk)
# 2. Fix ownership so iterate user can write
(
  while ! grep -q "archil" /proc/mounts 2>/dev/null; do sleep 1; done

  sudo chown iterate:iterate "${MOUNT_POINT}"

  # First boot: if the disk has no .bashrc, it's empty — extract image snapshot.
  # The tarball contains the full ~ from build time: repo, dotfiles, node_modules, etc.
  if [[ ! -f "${MOUNT_POINT}/.bashrc" ]] && [[ -f /opt/home.tar.gz ]]; then
    echo "[archil] First boot — extracting home tarball into persistent disk"
    tar xzf /opt/home.tar.gz -C "${MOUNT_POINT}"
    sudo chown -R iterate:iterate "${MOUNT_POINT}"
    echo "[archil] Extraction complete ($(du -sh "${MOUNT_POINT}" | cut -f1))"
  fi

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
