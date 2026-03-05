#!/bin/bash
# Benchmark: pnpm install on local disk vs Archil mount.
#
# Env vars:
#   MODE=baseline|archil
#   WORKLOAD=small|medium
#
# Archil mode also requires: ARCHIL_MOUNT_TOKEN, ARCHIL_DISK_ID, ARCHIL_REGION
set -euo pipefail

MODE="${MODE:-baseline}"
WORKLOAD="${WORKLOAD:-small}"
WORKDIR="/home/bench/project"
MOUNT_DIR="/mnt/archil"

# ── Workload definitions ──
PACKAGES_SMALL="lodash chalk request commander express"
PACKAGES_MEDIUM="@arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3"

case "$WORKLOAD" in
  small)  PACKAGES="$PACKAGES_SMALL" ;;
  medium) PACKAGES="$PACKAGES_MEDIUM" ;;
  *) echo "Unknown WORKLOAD: $WORKLOAD (expected small|medium)"; exit 1 ;;
esac

log() { echo "[bench:$MODE:$WORKLOAD] $*"; }

# ── Mount Archil ──
mount_archil() {
  local region="${ARCHIL_REGION}"
  case "$region" in aws-*|gcp-*) ;; *) region="aws-${region}" ;; esac

  sudo mkdir -p "$MOUNT_DIR"
  export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN}"
  sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "$ARCHIL_DISK_ID" "$MOUNT_DIR" \
    --region "$region" --force --log-dir /tmp/archil-logs &

  local waited=0
  while ! grep -q "$MOUNT_DIR" /proc/mounts 2>/dev/null; do
    sleep 0.5; waited=$((waited + 1))
    if [ $waited -gt 60 ]; then
      log "ERROR: mount timed out"; exit 1
    fi
  done
  sudo chown bench:bench "$MOUNT_DIR"
  log "Mounted $ARCHIL_DISK_ID at $MOUNT_DIR"
}

# ── Timing helper ──
time_cmd() {
  local label="$1"; shift
  local start end elapsed
  start=$(date +%s%N)
  "$@"
  end=$(date +%s%N)
  elapsed=$(echo "scale=3; ($end - $start) / 1000000000" | bc)
  log "RESULT ${label}=${elapsed}s"
}

# ── Baseline ──
run_baseline() {
  mkdir -p "$WORKDIR" && cd "$WORKDIR"
  pnpm init > /dev/null 2>&1
  log "Running: pnpm install $PACKAGES"
  time_cmd "pnpm_install" pnpm install $PACKAGES
  log "RESULT nm_files=$(find node_modules -type f | wc -l | tr -d ' ')"
}

# ── Archil ──
run_archil() {
  mount_archil

  local run_id="run-$(date +%s)"
  local archil_nm="$MOUNT_DIR/$run_id/node_modules"
  local archil_store="$MOUNT_DIR/$run_id/pnpm-store"

  mkdir -p "$WORKDIR" && cd "$WORKDIR"
  pnpm init > /dev/null 2>&1

  mkdir -p "$archil_nm" "$WORKDIR/node_modules"
  sudo mount --bind "$archil_nm" "$WORKDIR/node_modules"
  mkdir -p "$archil_store"
  export npm_config_store_dir="$archil_store"

  log "Running: pnpm install $PACKAGES (node_modules + store on Archil)"
  time_cmd "pnpm_install" pnpm install $PACKAGES
  log "RESULT nm_files=$(find node_modules -type f | wc -l | tr -d ' ')"
}

# ── Main ──
log "Started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
case "$MODE" in
  baseline) run_baseline ;;
  archil)   run_archil ;;
  *) log "Unknown mode: $MODE"; exit 1 ;;
esac
log "Completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
