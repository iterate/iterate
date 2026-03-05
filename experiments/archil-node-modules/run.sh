#!/bin/bash
# Orchestration script for archil-node-modules benchmark.
#
# Provisions Archil disks (if needed), builds the Docker image,
# runs baseline and archil scenarios, appends results to results.md.
#
# Usage:  doppler run -- ./run.sh
# Or:     doppler run -- ./run.sh [baseline|archil]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="archil-bench"
RESULTS_FILE="$SCRIPT_DIR/results.md"

log() { echo "==> $*"; }

# ─── Provision disks ───
provision_disks() {
  if [ -f "$SCRIPT_DIR/disk-config.json" ]; then
    log "disk-config.json exists, skipping provisioning (delete it to re-provision)"
  else
    log "Provisioning Archil disks..."
    npx tsx "$SCRIPT_DIR/setup-disks.ts"
  fi
}

# ─── Build Docker image ───
build_image() {
  log "Building Docker image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
}

# ─── Run a benchmark scenario, append to results.md ───
run_scenario() {
  local mode="$1"
  log "Running scenario: $mode"

  local docker_args=(
    --rm
    -e "MODE=$mode"
  )

  if [ "$mode" = "archil" ]; then
    local config
    config=$(cat "$SCRIPT_DIR/disk-config.json")

    local disk_id mount_token region
    disk_id=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['diskId'])")
    mount_token=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['mountToken'])")
    region=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['region'])")

    docker_args+=(
      --device /dev/fuse
      --cap-add SYS_ADMIN
      -e "ARCHIL_DISK_ID=$disk_id"
      -e "ARCHIL_MOUNT_TOKEN=$mount_token"
      -e "ARCHIL_REGION=$region"
    )
  fi

  docker_args+=("$IMAGE_NAME")

  echo "" >> "$RESULTS_FILE"
  echo "### $mode" >> "$RESULTS_FILE"
  echo '```' >> "$RESULTS_FILE"

  # Run container, tee to both stdout and results file
  docker run "${docker_args[@]}" 2>&1 | tee -a "$RESULTS_FILE"

  echo '```' >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"
  log "Scenario $mode complete."
}

# ─── Main ───
cd "$SCRIPT_DIR"

if [ -z "${ARCHIL_API_KEY:-}" ]; then
  echo "ERROR: Missing ARCHIL_API_KEY. Run with: doppler run -- $0"
  exit 1
fi

provision_disks
build_image

# Start fresh results file
echo "# Archil node_modules benchmark — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULTS_FILE"

scenarios="${1:-all}"
if [ "$scenarios" = "all" ]; then
  run_scenario "baseline"
  run_scenario "archil"
else
  run_scenario "$scenarios"
fi

log "Done. Results in $RESULTS_FILE"
