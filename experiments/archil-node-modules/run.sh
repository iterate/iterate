#!/bin/bash
# Orchestration script for archil-node-modules benchmark.
#
# Provisions Archil disks (if needed), builds the Docker image,
# runs all three benchmark scenarios, and prints results.
#
# Usage:  doppler run -- ./run.sh
# Or:     doppler run -- ./run.sh [baseline|archil|bundle]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="archil-bench"
RESULTS_BASE="$SCRIPT_DIR/results"

log() { echo "==> $*"; }

# ─── Step 1: Provision disks ───
provision_disks() {
  if [ -f "$SCRIPT_DIR/disk-config.json" ]; then
    log "disk-config.json exists, skipping provisioning (delete it to re-provision)"
  else
    log "Provisioning Archil disks..."
    npx tsx "$SCRIPT_DIR/setup-disks.ts"
  fi
}

# ─── Step 2: Build Docker image ───
build_image() {
  log "Building Docker image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
}

# ─── Step 3: Run a benchmark scenario ───
run_scenario() {
  local mode="$1"
  local results_dir="$RESULTS_BASE/$mode"
  mkdir -p "$results_dir"

  log "Running scenario: $mode"

  local docker_args=(
    --rm
    -v "$results_dir:/results"
    -e "MODE=$mode"
  )

  # Archil and bundle modes need FUSE + credentials
  if [ "$mode" = "archil" ] || [ "$mode" = "bundle" ]; then
    local config
    config=$(cat "$SCRIPT_DIR/disk-config.json")

    local disk_key
    if [ "$mode" = "archil" ]; then
      disk_key="nm"
    else
      disk_key="bundle"
    fi

    local disk_id mount_token region
    disk_id=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['$disk_key']['diskId'])")
    mount_token=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['$disk_key']['mountToken'])")
    region=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['$disk_key']['region'])")

    docker_args+=(
      --device /dev/fuse
      --cap-add SYS_ADMIN
      -e "ARCHIL_DISK_ID=$disk_id"
      -e "ARCHIL_MOUNT_TOKEN=$mount_token"
      -e "ARCHIL_REGION=$region"
    )
  fi

  docker_args+=("$IMAGE_NAME")

  log "docker run ${docker_args[*]}"
  docker run "${docker_args[@]}" 2>&1 | tee "$results_dir/output.log"

  log "Scenario $mode complete. Results in $results_dir/"
}

# ─── Step 4: Print summary ───
print_summary() {
  log ""
  log "═══════════════════════════════════════════════════════"
  log "  BENCHMARK RESULTS SUMMARY"
  log "═══════════════════════════════════════════════════════"

  for mode_dir in "$RESULTS_BASE"/*/; do
    local mode
    mode=$(basename "$mode_dir")
    log ""
    log "─── $mode ───"
    if [ -f "$mode_dir/timings.jsonl" ]; then
      cat "$mode_dir/timings.jsonl"
    elif [ -f "$mode_dir/output.log" ]; then
      grep -E "^\[bench:" "$mode_dir/output.log" | tail -20
    else
      echo "  (no results)"
    fi
  done

  log ""
  log "═══════════════════════════════════════════════════════"
}

# ─── Main ───
cd "$SCRIPT_DIR"

# Check we have doppler env
if [ -z "${ARCHIL_API_KEY:-}" ]; then
  echo "ERROR: Missing ARCHIL_API_KEY. Run with: doppler run -- $0"
  exit 1
fi

provision_disks
build_image

# Run specified scenarios or all of them
scenarios="${1:-all}"
if [ "$scenarios" = "all" ]; then
  run_scenario "baseline"
  run_scenario "archil"
  run_scenario "bundle"
else
  run_scenario "$scenarios"
fi

print_summary
