#!/bin/bash
# Archil persistent volume mount + opencode sqlite sync — managed by pidnap.
#
# Mounts archil at /mnt/persist (NOT over ~). The Docker image already has the
# repo + node_modules baked in, so boot is instant.
#
# Persisted state:
#   - ~/persisted → /mnt/persist/persisted (user files that survive reprovisioning)
#   - OpenCode sqlite snapshot (restored on boot, synced periodically)
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

# Periodic opencode sqlite snapshot. Runs forever after setup completes.
opencode_sync_loop() {
  local live_db="${HOME_DIR}/.local/share/opencode/opencode.db"
  local snapshot_dir="${PERSIST}/.opencode-snapshot"
  local snapshot_db="${snapshot_dir}/opencode.db"
  local tmp_db="${snapshot_db}.tmp"
  local interval="${ARCHIL_OPENCODE_SYNC_INTERVAL_SEC:-20}"
  local last_sig=""

  mkdir -p "${snapshot_dir}"
  echo "[archil] opencode sync started (interval=${interval}s)"

  while true; do
    if [[ -f "${live_db}" ]]; then
      local sig
      sig="$(stat -c '%s:%Y' "${live_db}" 2>/dev/null || true)"
      if [[ -n "${sig}" ]] && [[ "${sig}" != "${last_sig}" ]]; then
        if python3 - "${live_db}" "${tmp_db}" <<'PY'
import sqlite3, sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
target = sqlite3.connect(sys.argv[2])
try:
    source.backup(target)
finally:
    target.close()
    source.close()
PY
        then
          mv -f "${tmp_db}" "${snapshot_db}"
          last_sig="${sig}"
          echo "[archil] opencode snapshot updated (${sig})"
        else
          rm -f "${tmp_db}"
          echo "[archil] opencode snapshot failed; will retry"
        fi
      fi
    fi
    sleep "${interval}"
  done
}

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

  # Signal ready — dependents (opencode, daemon, etc.) can start now
  touch /tmp/archil-repo-ready
  echo "[archil] Setup complete, repo ready"

  # Enter the opencode sync loop (runs forever)
  opencode_sync_loop
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
