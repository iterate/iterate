#!/bin/bash
# Benchmark: pnpm install on local disk vs Archil mount.
#
# Env vars:
#   MODE=baseline|archil
#   WORKLOAD=small|medium
#   ARCHIL_MOUNT_OPTS — extra flags for archil mount (e.g. "--writeback-cache --nconnect 4")
#   USE_EATMYDATA=1 — prefix pnpm install with eatmydata (no-ops fsync)
#
# Archil mode also requires: ARCHIL_MOUNT_TOKEN, ARCHIL_DISK_ID, ARCHIL_REGION
set -euo pipefail

MODE="${MODE:-baseline}"
WORKLOAD="${WORKLOAD:-small}"
ARCHIL_MOUNT_OPTS="${ARCHIL_MOUNT_OPTS:-}"
USE_EATMYDATA="${USE_EATMYDATA:-}"
WORKDIR="/home/bench/project"
MOUNT_DIR="/mnt/archil"
STATS_FILE="/tmp/resource-stats.log"

# Build pnpm command prefix
PNPM_PREFIX=""
if [ -n "$USE_EATMYDATA" ]; then
  PNPM_PREFIX="eatmydata"
fi

# ── Workload definitions ──
PACKAGES_SMALL="lodash chalk request commander express"
PACKAGES_MEDIUM="@arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3"

case "$WORKLOAD" in
  small)  PACKAGES="$PACKAGES_SMALL" ;;
  medium) PACKAGES="$PACKAGES_MEDIUM" ;;
  *) echo "Unknown WORKLOAD: $WORKLOAD (expected small|medium)"; exit 1 ;;
esac

log() { echo "[bench:$MODE:$WORKLOAD] $*"; }

# ── Resource monitoring ──
start_resource_monitor() {
  (
    while true; do
      local ts cpu_line mem_total mem_avail mem_used_pct
      ts=$(date +%s)
      # CPU: grab idle% from /proc/stat, compute usage
      read -r _ user nice system idle rest < /proc/stat
      local total=$((user + nice + system + idle))
      sleep 2
      read -r _ user2 nice2 system2 idle2 rest2 < /proc/stat
      local total2=$((user2 + nice2 + system2 + idle2))
      local dtotal=$((total2 - total))
      local didle=$((idle2 - idle))
      if [ "$dtotal" -gt 0 ]; then
        cpu_line=$(echo "scale=1; 100 * ($dtotal - $didle) / $dtotal" | bc)
      else
        cpu_line="0.0"
      fi
      # Memory from /proc/meminfo
      mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
      mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
      local mem_used=$((mem_total - mem_avail))
      mem_used_pct=$(echo "scale=1; 100 * $mem_used / $mem_total" | bc)
      local mem_used_mb=$((mem_used / 1024))
      local mem_total_mb=$((mem_total / 1024))
      echo "$ts cpu=${cpu_line}% mem=${mem_used_mb}/${mem_total_mb}MB (${mem_used_pct}%)" >> "$STATS_FILE"
    done
  ) &
  MONITOR_PID=$!
}

stop_resource_monitor() {
  if [ -n "${MONITOR_PID:-}" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  if [ -f "$STATS_FILE" ]; then
    # Compute peak and average CPU/memory
    local peak_cpu avg_cpu peak_mem avg_mem samples
    samples=$(wc -l < "$STATS_FILE")
    peak_cpu=$(awk '{gsub(/cpu=|%/,"",$2); print $2}' "$STATS_FILE" | sort -n | tail -1)
    avg_cpu=$(awk '{gsub(/cpu=|%/,"",$2); sum+=$2; n++} END{if(n>0) printf "%.1f", sum/n; else print "0"}' "$STATS_FILE")
    peak_mem=$(awk '{split($3,a,"/"); gsub(/mem=|MB/,"",a[1]); print a[1]}' "$STATS_FILE" | sort -n | tail -1)
    avg_mem=$(awk '{split($3,a,"/"); gsub(/mem=|MB/,"",a[1]); sum+=a[1]; n++} END{if(n>0) printf "%.0f", sum/n; else print "0"}' "$STATS_FILE")
    local total_mem_mb=$(awk '{split($3,a,"/"); gsub(/MB.*/,"",a[2]); print a[2]}' "$STATS_FILE" | tail -1)
    log "RESULT cpu_peak=${peak_cpu}%"
    log "RESULT cpu_avg=${avg_cpu}%"
    log "RESULT mem_peak=${peak_mem}MB"
    log "RESULT mem_avg=${avg_mem}MB"
    log "RESULT mem_total=${total_mem_mb}MB"
    log "RESULT resource_samples=${samples}"
  fi
}

# ── Mount Archil ──
mount_archil() {
  local region="${ARCHIL_REGION}"
  case "$region" in aws-*|gcp-*) ;; *) region="aws-${region}" ;; esac

  sudo mkdir -p "$MOUNT_DIR"
  export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN}"
  # shellcheck disable=SC2086
  sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "$ARCHIL_DISK_ID" "$MOUNT_DIR" \
    --region "$region" --force --log-dir /tmp/archil-logs $ARCHIL_MOUNT_OPTS &

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
  log "Running: ${PNPM_PREFIX:+$PNPM_PREFIX }pnpm install $PACKAGES"
  start_resource_monitor
  # shellcheck disable=SC2086
  time_cmd "pnpm_install" $PNPM_PREFIX pnpm install $PACKAGES
  stop_resource_monitor
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

  log "Running: ${PNPM_PREFIX:+$PNPM_PREFIX }pnpm install $PACKAGES (node_modules + store on Archil)"
  [ -n "$ARCHIL_MOUNT_OPTS" ] && log "Mount opts: $ARCHIL_MOUNT_OPTS"
  [ -n "$USE_EATMYDATA" ] && log "Using eatmydata (fsync no-op)"
  start_resource_monitor
  # shellcheck disable=SC2086
  time_cmd "pnpm_install" $PNPM_PREFIX pnpm install $PACKAGES
  stop_resource_monitor
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
