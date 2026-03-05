#!/bin/bash
# Benchmark entrypoint — runs inside Docker container.
#
# Usage:
#   MODE=baseline ./benchmark.sh          — pnpm install on local disk (control)
#   MODE=archil  ./benchmark.sh           — pnpm install with node_modules on archil
#   MODE=bundle  ./benchmark.sh           — git bundle sync to archil
#
# Required env vars for archil/bundle modes:
#   ARCHIL_MOUNT_TOKEN, ARCHIL_DISK_ID, ARCHIL_REGION
#
# Writes results to /results/timings.jsonl
set -euo pipefail

MODE="${MODE:-baseline}"
RESULTS_DIR="/results"
REPO_URL="https://github.com/iterate/iterate.git"
REPO_DIR="/home/bench/repo"
MOUNT_DIR="/mnt/archil"

mkdir -p "$RESULTS_DIR"

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
  echo "\"${label}\": ${elapsed}" >> "$RESULTS_DIR/timings.jsonl"
  log "$label: ${elapsed}s (exit=$exit_code)"
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

# ─── Clone repo ───
clone_repo() {
  local target="${1:-$REPO_DIR}"
  if [ -d "$target/.git" ]; then
    log "Repo already cloned at $target"
  else
    log "Cloning $REPO_URL into $target ..."
    time_cmd "git_clone" git clone --depth=1 "$REPO_URL" "$target"
  fi
}

# ─── Count files helper ───
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
  log "node_modules files: $nm_files"

  time_cmd "find_node_modules" find "$REPO_DIR/node_modules" -type f -name "*.js" > /dev/null

  echo "{\"nm_files\": $nm_files}" >> "$RESULTS_DIR/timings.jsonl"
}

# ─── Benchmark: Archil ───
run_archil() {
  log "=== ARCHIL: pnpm install with node_modules on archil ==="
  mount_archil

  # Clean old data on archil
  log "Cleaning archil mount..."
  rm -rf "$MOUNT_DIR/node_modules" 2>/dev/null || true

  clone_repo "$REPO_DIR"

  # Create node_modules on archil, then bind-mount it over the repo's node_modules
  mkdir -p "$MOUNT_DIR/node_modules"
  mkdir -p "$REPO_DIR/node_modules"
  sudo mount --bind "$MOUNT_DIR/node_modules" "$REPO_DIR/node_modules"
  log "Bind-mounted $MOUNT_DIR/node_modules -> $REPO_DIR/node_modules"

  # Also put the pnpm store on archil so hardlinks work (pnpm needs
  # source and target on the same filesystem for hardlinks)
  mkdir -p "$MOUNT_DIR/pnpm-store"
  export npm_config_store_dir="$MOUNT_DIR/pnpm-store"

  log "Running pnpm install (node_modules + store on archil) ..."
  time_cmd "pnpm_install" pnpm install --dir "$REPO_DIR" --frozen-lockfile

  local nm_files
  nm_files=$(count_files "$REPO_DIR/node_modules")
  log "node_modules files on archil: $nm_files"

  time_cmd "find_node_modules" find "$REPO_DIR/node_modules" -type f -name "*.js" > /dev/null

  echo "{\"nm_files\": $nm_files}" >> "$RESULTS_DIR/timings.jsonl"
}

# ─── Benchmark: Git Bundle ───
run_bundle() {
  log "=== BUNDLE: git bundle sync to archil ==="
  mount_archil

  rm -rf "$MOUNT_DIR/bundles" 2>/dev/null || true
  mkdir -p "$MOUNT_DIR/bundles"

  clone_repo "$REPO_DIR"

  # pnpm install on local disk (same as baseline)
  log "Running pnpm install (local disk) ..."
  time_cmd "pnpm_install" pnpm install --dir "$REPO_DIR" --frozen-lockfile

  # Create git bundle
  log "Creating git bundle..."
  # --depth=1 clones don't have full history; bundle just HEAD
  time_cmd "git_bundle_create" git -C "$REPO_DIR" bundle create /tmp/repo.bundle HEAD

  local bundle_size
  bundle_size=$(stat -c%s /tmp/repo.bundle 2>/dev/null || stat -f%z /tmp/repo.bundle)
  log "Bundle size: $bundle_size bytes ($(echo "scale=1; $bundle_size / 1048576" | bc)MB)"

  # Copy bundle to archil
  log "Copying bundle to archil..."
  time_cmd "bundle_copy_to_archil" cp /tmp/repo.bundle "$MOUNT_DIR/bundles/repo.bundle"

  # Simulate restore: clone from the archil-backed bundle to local disk
  log "Cloning from bundle on archil..."
  local restore_dir="/home/bench/restored"
  time_cmd "bundle_restore" git clone "$MOUNT_DIR/bundles/repo.bundle" "$restore_dir"

  # pnpm install on the restored repo (local disk)
  log "Running pnpm install on restored repo (local disk, cached store) ..."
  time_cmd "pnpm_install_from_bundle" pnpm install --dir "$restore_dir" --frozen-lockfile

  echo "{\"bundle_size_bytes\": $bundle_size}" >> "$RESULTS_DIR/timings.jsonl"
}

# ─── Main ───
log "Starting benchmark (mode=$MODE)"
echo "# Results for mode=$MODE" > "$RESULTS_DIR/timings.jsonl"
echo "{\"mode\": \"$MODE\", \"started\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$RESULTS_DIR/timings.jsonl"

case "$MODE" in
  baseline) run_baseline ;;
  archil)   run_archil ;;
  bundle)   run_bundle ;;
  *) log "Unknown mode: $MODE"; exit 1 ;;
esac

echo "{\"completed\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$RESULTS_DIR/timings.jsonl"
log "Benchmark complete. Results:"
cat "$RESULTS_DIR/timings.jsonl"
