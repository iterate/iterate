#!/bin/bash
# Benchmark entrypoint — runs inside Docker container.
# All results go to stdout (the orchestrator captures them).
#
# Usage:
#   MODE=baseline ./benchmark.sh   — pnpm install on local disk (control)
#   MODE=archil  ./benchmark.sh    — pnpm install with node_modules on archil
#
# Required env vars for archil mode:
#   ARCHIL_MOUNT_TOKEN, ARCHIL_DISK_ID, ARCHIL_REGION
set -euo pipefail

MODE="${MODE:-baseline}"
REPO_URL="https://github.com/mmkal/expect-type.git"
REPO_DIR="/home/bench/repo"
MOUNT_DIR="/mnt/archil"

log() { echo "[bench:$MODE] $*"; }

# ─── Timing helper ───
time_cmd() {
  local label="$1"; shift
  local start end elapsed
  start=$(date +%s%N)
  "$@"
  local exit_code=$?
  end=$(date +%s%N)
  elapsed=$(echo "scale=3; ($end - $start) / 1000000000" | bc)
  log "RESULT $label=${elapsed}s"
  return $exit_code
}

# ─── Mount Archil ───
mount_archil() {
  log "Mounting archil disk $ARCHIL_DISK_ID at $MOUNT_DIR ..."
  sudo mkdir -p "$MOUNT_DIR"

  local region="${ARCHIL_REGION}"
  case "$region" in
    aws-*|gcp-*) ;;
    *) region="aws-${region}" ;;
  esac

  export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN}"

  sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "$ARCHIL_DISK_ID" "$MOUNT_DIR" \
    --region "$region" \
    --force \
    --log-dir /tmp/archil-logs &

  local waited=0
  while ! grep -q "$MOUNT_DIR" /proc/mounts 2>/dev/null; do
    sleep 0.5
    waited=$((waited + 1))
    if [ $waited -gt 60 ]; then
      log "ERROR: Archil mount timed out after 30s"
      cat /tmp/archil-logs/*/*.log 2>/dev/null || true
      exit 1
    fi
  done
  log "Archil mounted at $MOUNT_DIR"
  sudo chown bench:bench "$MOUNT_DIR"
}

clone_repo() {
  local target="${1:-$REPO_DIR}"
  log "Cloning $REPO_URL into $target ..."
  time_cmd "git_clone" git clone --depth=1 "$REPO_URL" "$target"
}

count_files() {
  find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}

# ─── Benchmark: Baseline ───
run_baseline() {
  log "=== BASELINE: pnpm install on local disk ==="
  clone_repo "$REPO_DIR"

  log "Running pnpm install (local disk) ..."
  time_cmd "pnpm_install" pnpm install --dir "$REPO_DIR" --frozen-lockfile

  local nm_files
  nm_files=$(count_files "$REPO_DIR/node_modules")
  log "RESULT nm_files=$nm_files"

  time_cmd "find_node_modules" find "$REPO_DIR/node_modules" -type f -name "*.js" > /dev/null
}

# ─── Benchmark: Archil ───
run_archil() {
  log "=== ARCHIL: pnpm install with node_modules on archil ==="
  mount_archil

  # Use a unique subdirectory per run to avoid slow rm -rf on FUSE.
  local run_id
  run_id="run-$(date +%s)"
  local archil_nm="$MOUNT_DIR/$run_id/node_modules"
  local archil_store="$MOUNT_DIR/$run_id/pnpm-store"
  log "Using archil subdir: $MOUNT_DIR/$run_id"

  clone_repo "$REPO_DIR"

  mkdir -p "$archil_nm"
  mkdir -p "$REPO_DIR/node_modules"
  sudo mount --bind "$archil_nm" "$REPO_DIR/node_modules"
  log "Bind-mounted $archil_nm -> $REPO_DIR/node_modules"

  mkdir -p "$archil_store"
  export npm_config_store_dir="$archil_store"

  local timeout=${ARCHIL_TIMEOUT:-300}
  log "Running pnpm install (node_modules + store on archil, timeout=${timeout}s) ..."

  local start end elapsed
  start=$(date +%s%N)

  # Run with timeout — pnpm install can stall for hours on slow FUSE mounts.
  set +e
  timeout "$timeout" pnpm install --dir "$REPO_DIR" --frozen-lockfile 2>&1
  local exit_code=$?
  set -e

  end=$(date +%s%N)
  elapsed=$(echo "scale=3; ($end - $start) / 1000000000" | bc)

  if [ $exit_code -eq 124 ]; then
    log "RESULT pnpm_install=TIMEOUT (${timeout}s limit, ran for ${elapsed}s)"
    log "RESULT pnpm_timed_out=true"
  else
    log "RESULT pnpm_install=${elapsed}s (exit=$exit_code)"
  fi

  local nm_files
  nm_files=$(count_files "$REPO_DIR/node_modules")
  log "RESULT nm_files=$nm_files"

  if [ "$nm_files" -gt 0 ]; then
    time_cmd "find_node_modules" find "$REPO_DIR/node_modules" -type f -name "*.js" > /dev/null
  fi
}

# ─── Main ───
log "Starting benchmark (mode=$MODE) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

case "$MODE" in
  baseline) run_baseline ;;
  archil)   run_archil ;;
  *) log "Unknown mode: $MODE"; exit 1 ;;
esac

log "Completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
