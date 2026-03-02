#!/bin/bash
# Periodically snapshot OpenCode sqlite db to archil persist volume.
# Live db stays on local disk; snapshots are restored by archil-mount.sh.
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST_DIR="${ARCHIL_PERSIST_DIR:-/mnt/persist}"
LIVE_DB="${HOME_DIR}/.local/share/opencode/opencode.db"
SNAPSHOT_DIR="${PERSIST_DIR}/.iterate/opencode"
SNAPSHOT_DB="${SNAPSHOT_DIR}/opencode.db"
TMP_DB="${SNAPSHOT_DB}.tmp"
INTERVAL_SEC="${ARCHIL_OPENCODE_SYNC_INTERVAL_SEC:-20}"

mkdir -p "${SNAPSHOT_DIR}"

echo "[archil-opencode-sync] started (interval=${INTERVAL_SEC}s)"

last_sig=""
while true; do
  if [[ -f "${LIVE_DB}" ]]; then
    sig="$(stat -c '%s:%Y' "${LIVE_DB}" 2>/dev/null || true)"
    if [[ -n "${sig}" ]] && [[ "${sig}" != "${last_sig}" ]]; then
      if python3 - "${LIVE_DB}" "${TMP_DB}" <<'PY'
import sqlite3
import sys

src = sys.argv[1]
dst = sys.argv[2]

source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
target = sqlite3.connect(dst)
try:
    source.backup(target)
finally:
    target.close()
    source.close()
PY
      then
        mv -f "${TMP_DB}" "${SNAPSHOT_DB}"
        last_sig="${sig}"
        echo "[archil-opencode-sync] snapshot updated (${sig})"
      else
        rm -f "${TMP_DB}"
        echo "[archil-opencode-sync] snapshot failed; will retry"
      fi
    fi
  fi

  sleep "${INTERVAL_SEC}"
done
