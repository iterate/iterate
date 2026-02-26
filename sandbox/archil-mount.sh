#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~ so the entire home directory
# persists across machine reprovisioning.
#
# First boot: seeds the archil disk from the image's home dir dotfiles/configs.
# Subsequent boots: archil already has the home dir contents.
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

MOUNT_POINT="/home/iterate"

# Source env vars from .env files if not already set via process env
for env_file in /home/iterate/.iterate/.env; do
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

# Snapshot dotfiles/configs BEFORE mount hides them. The repo has already been
# moved to /opt/iterate-repo by entry.sh, so this only captures dotfiles (~fast).
# Skip if snapshot already exists (pidnap restart after a failed mount attempt).
if [[ ! -d /tmp/home-seed ]]; then
  rsync -a --exclude='src/' "${MOUNT_POINT}/" /tmp/home-seed/
  echo "[archil] Saved home-seed snapshot ($(du -sh /tmp/home-seed | cut -f1))"
fi

# Post-mount tasks run in background since --no-fork blocks the main thread:
# 1. Seed from /tmp/home-seed on first boot (empty disk)
# 2. Fix ownership so iterate user can write
# 3. Symlink iterate repo from /opt/iterate-repo into ~
(
  while ! grep -q "archil" /proc/mounts 2>/dev/null; do sleep 1; done

  sudo chown iterate:iterate "${MOUNT_POINT}"

  # Seed on first boot: if the disk has no .bashrc, it's empty — copy image defaults.
  if [[ -d /tmp/home-seed ]] && [[ ! -f "${MOUNT_POINT}/.bashrc" ]]; then
    echo "[archil] First boot — seeding home dir from image defaults"
    sudo cp -a /tmp/home-seed/. "${MOUNT_POINT}/"
    sudo chown -R iterate:iterate "${MOUNT_POINT}"
    echo "[archil] Seed complete"
  fi

  # Symlink iterate repo into ~ so it's accessible at the expected path.
  # The repo lives in /opt/iterate-repo (moved there by entry.sh) and is NOT
  # stored on the archil disk to avoid duplicating ~2GB of node_modules.
  if [[ -d /opt/iterate-repo ]] && [[ ! -d "${MOUNT_POINT}/src/github.com/iterate/iterate/sandbox" ]]; then
    mkdir -p "${MOUNT_POINT}/src/github.com/iterate"
    ln -sfn /opt/iterate-repo "${MOUNT_POINT}/src/github.com/iterate/iterate"
    echo "[archil] Linked iterate repo into home dir"
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
