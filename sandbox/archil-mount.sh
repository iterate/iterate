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
#
# ARCHIL_SYNC_DIRS: colon-separated list of directories to sync.
# Each dir at <path> gets a mirror at /mnt/persist/.dir-snapshots/<mangled-path>/
# and is restored on boot if a mirror exists. Used for non-sqlite state like
# opencode's storage/ directory (session diffs, migration markers).
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST="/mnt/persist"
ITERATE_REPO="${ITERATE_REPO:-${HOME_DIR}/src/github.com/iterate/iterate}"
SNAPSHOT_DIR="${PERSIST}/.sqlite-snapshots"
DIR_SNAPSHOT_DIR="${PERSIST}/.dir-snapshots"
OPENCODE_DIR="${HOME_DIR}/.local/share/opencode"

# Default dbs to sync — extend by setting ARCHIL_SYNC_DBS
DEFAULT_SYNC_DBS="${OPENCODE_DIR}/opencode.db:${HOME_DIR}/.iterate/events.sqlite:${ITERATE_REPO}/apps/daemon/db.sqlite"
SYNC_DBS="${ARCHIL_SYNC_DBS:-${DEFAULT_SYNC_DBS}}"

# Default dirs to sync — extend by setting ARCHIL_SYNC_DIRS
DEFAULT_SYNC_DIRS="${OPENCODE_DIR}/storage"
SYNC_DIRS="${ARCHIL_SYNC_DIRS:-${DEFAULT_SYNC_DIRS}}"

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

# Restore all directory snapshots from persist volume → local disk.
restore_dir_snapshots() {
  IFS=':' read -ra dirs <<< "${SYNC_DIRS}"
  for dir_path in "${dirs[@]}"; do
    [[ -z "$dir_path" ]] && continue
    local snap="${DIR_SNAPSHOT_DIR}/$(snapshot_name "$dir_path")"
    if [[ -d "$snap" ]]; then
      mkdir -p "$dir_path"
      cp -rf "$snap/." "$dir_path/"
      echo "[archil] Restored dir snapshot: $dir_path"
    fi
  done
}

# Compute a change signature for a sqlite db by checking both the main file
# AND the WAL file. SQLite WAL mode writes new data to the -wal file; the main
# file's stat doesn't change until a checkpoint. Without checking the WAL, we
# miss changes and the snapshot goes stale.
db_signature() {
  local db_path="$1"
  local main_sig wal_sig
  main_sig="$(stat -c '%s:%Y' "$db_path" 2>/dev/null || true)"
  wal_sig="$(stat -c '%s:%Y' "${db_path}-wal" 2>/dev/null || echo "0:0")"
  echo "${main_sig}|${wal_sig}"
}

# Periodic sync loop. Backs up sqlite dbs (via `sqlite3 .backup` to safely
# capture WAL data) and rsyncs plain directories.
sync_loop() {
  local interval="${ARCHIL_SQLITE_SYNC_INTERVAL_SEC:-20}"
  mkdir -p "${SNAPSHOT_DIR}" "${DIR_SNAPSHOT_DIR}"

  # Track last-seen signatures per db (main file + WAL file stats)
  declare -A last_sigs

  echo "[archil] sync started (interval=${interval}s, dbs=${SYNC_DBS}, dirs=${SYNC_DIRS})"

  while true; do
    # Sync sqlite databases
    IFS=':' read -ra dbs <<< "${SYNC_DBS}"
    for db_path in "${dbs[@]}"; do
      [[ -z "$db_path" ]] && continue
      [[ -f "$db_path" ]] || continue

      local sig
      sig="$(db_signature "$db_path")"
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

    # Sync directories (plain files only, no sqlite concerns)
    IFS=':' read -ra dirs <<< "${SYNC_DIRS}"
    for dir_path in "${dirs[@]}"; do
      [[ -z "$dir_path" ]] && continue
      [[ -d "$dir_path" ]] || continue
      local snap="${DIR_SNAPSHOT_DIR}/$(snapshot_name "$dir_path")"
      mkdir -p "$snap"
      # rsync with --delete so removed files are cleaned up
      if command -v rsync &>/dev/null; then
        rsync -a --delete "$dir_path/" "$snap/" 2>/dev/null || true
      else
        cp -rf "$dir_path/." "$snap/" 2>/dev/null || true
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

  # Migrate old single-db snapshot layout → new multi-db layout.
  # Old: /mnt/persist/.opencode-snapshot/opencode.db
  # New: /mnt/persist/.sqlite-snapshots/home-iterate-.local-share-opencode-opencode.db
  OLD_SNAPSHOT="${PERSIST}/.opencode-snapshot/opencode.db"
  NEW_SNAPSHOT="${SNAPSHOT_DIR}/$(snapshot_name "${HOME_DIR}/.local/share/opencode/opencode.db")"
  if [[ -f "${OLD_SNAPSHOT}" ]] && [[ ! -f "${NEW_SNAPSHOT}" ]]; then
    mkdir -p "${SNAPSHOT_DIR}"
    mv -f "${OLD_SNAPSHOT}" "${NEW_SNAPSHOT}"
    echo "[archil] Migrated old opencode snapshot to new layout"
  fi

  # Restore snapshots before signaling ready
  restore_snapshots
  restore_dir_snapshots

  # Signal ready — dependents (opencode, daemon, etc.) can start now
  touch /tmp/archil-repo-ready
  echo "[archil] Setup complete, repo ready"

  # Enter the sync loop (runs forever)
  sync_loop
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.
