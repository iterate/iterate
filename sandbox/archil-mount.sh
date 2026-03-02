#!/bin/bash
# Archil persistent volume mount + sqlite sync — managed by pidnap.
#
# Mounts archil at /mnt/persist (NOT over ~). The Docker image already has the
# repo + node_modules baked in, so boot is instant.
#
# Persisted state:
#   - ~/persisted → /mnt/persist/persisted (user files that survive reprovisioning)
#   - SQLite databases (restored on boot, synced periodically via `sqlite3 .backup`)
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
#
# ARCHIL_SYNC_DBS: colon-separated list of sqlite db paths to sync.
# Each db at <path> gets a snapshot at /mnt/persist/.sqlite-snapshots/<mangled-path>.db
# and is restored on boot if a snapshot exists.
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST="/mnt/persist"
ITERATE_REPO="${ITERATE_REPO:-${HOME_DIR}/src/github.com/iterate/iterate}"
SNAPSHOT_DIR="${PERSIST}/.sqlite-snapshots"

# Default dbs to sync — extend by setting ARCHIL_SYNC_DBS
DEFAULT_SYNC_DBS="${HOME_DIR}/.local/share/opencode/opencode.db:${HOME_DIR}/.iterate/events.sqlite:${ITERATE_REPO}/apps/daemon/db.sqlite"
SYNC_DBS="${ARCHIL_SYNC_DBS:-${DEFAULT_SYNC_DBS}}"

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

# Mangle a db path into a safe filename for the snapshot dir.
# e.g. /home/iterate/.local/share/opencode/opencode.db → home-iterate-.local-share-opencode-opencode.db
snapshot_name() {
  echo "$1" | sed 's|^/||; s|/|-|g'
}

# Restore all sqlite snapshots from persist volume → local disk.
restore_snapshots() {
  IFS=':' read -ra dbs <<< "${SYNC_DBS}"
  for db_path in "${dbs[@]}"; do
    [[ -z "$db_path" ]] && continue
    local snap="${SNAPSHOT_DIR}/$(snapshot_name "$db_path")"
    if [[ -f "$snap" ]]; then
      mkdir -p "$(dirname "$db_path")"
      cp -f "$snap" "$db_path"
      echo "[archil] Restored snapshot: $db_path"
    fi
  done
}

# Periodic sqlite snapshot loop. Backs up each db that exists and has changed.
sqlite_sync_loop() {
  local interval="${ARCHIL_SQLITE_SYNC_INTERVAL_SEC:-20}"
  mkdir -p "${SNAPSHOT_DIR}"

  # Track last-seen size:mtime per db
  declare -A last_sigs

  echo "[archil] sqlite sync started (interval=${interval}s, dbs=${SYNC_DBS})"

  while true; do
    IFS=':' read -ra dbs <<< "${SYNC_DBS}"
    for db_path in "${dbs[@]}"; do
      [[ -z "$db_path" ]] && continue
      [[ -f "$db_path" ]] || continue

      local sig
      sig="$(stat -c '%s:%Y' "$db_path" 2>/dev/null || true)"
      [[ -z "$sig" ]] && continue
      [[ "$sig" == "${last_sigs[$db_path]:-}" ]] && continue

      local snap="${SNAPSHOT_DIR}/$(snapshot_name "$db_path")"
      local tmp="${snap}.tmp"
      if sqlite3 "$db_path" ".backup '${tmp}'" 2>/dev/null; then
        mv -f "$tmp" "$snap"
        last_sigs[$db_path]="$sig"
        echo "[archil] snapshot: $(basename "$db_path") (${sig})"
      else
        rm -f "$tmp"
        echo "[archil] snapshot failed: $(basename "$db_path"); will retry"
      fi
    done
    sleep "$interval"
  done
}

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

  # Restore sqlite snapshots before signaling ready
  restore_snapshots

  # Signal ready — dependents (opencode, daemon, etc.) can start now
  touch /tmp/archil-repo-ready
  echo "[archil] Setup complete, repo ready"

  # Enter the sqlite sync loop (runs forever)
  sqlite_sync_loop
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
