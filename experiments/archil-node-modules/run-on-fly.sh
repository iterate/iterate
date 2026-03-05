#!/bin/bash
# Run the Archil node_modules benchmark on Fly.io.
#
# Prerequisites:
#   - Fly CLI authenticated (flyctl auth docker)
#   - Archil disks provisioned (disk-config.json exists)
#   - Image pushed: registry.fly.io/iterate-sandbox:archil-bench
#
# Usage: doppler run -- ./run-on-fly.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="archil-bench-exp"
IMAGE="registry.fly.io/iterate-sandbox:archil-bench"
REGION="lhr"  # London — closest Fly region to Archil aws-eu-west-1
RESULTS_FILE="$SCRIPT_DIR/results.md"

log() { echo "==> $*"; }

# ── Build & push ──
log "Building and pushing image..."
docker buildx build --platform linux/amd64 \
  -t "$IMAGE" --push "$SCRIPT_DIR" 2>&1 | tail -3

# ── Create Fly app ──
fly apps create "$APP_NAME" --org iterate 2>/dev/null || true

# ── Run a scenario, capture logs ──
run_scenario() {
  local mode="$1"
  log "Running: $mode"

  local args=(
    "$IMAGE"
    --app "$APP_NAME"
    --region "$REGION"
    --vm-cpus 4 --vm-memory 4096 --vm-cpu-kind shared
    -e "MODE=$mode"
  )

  if [ "$mode" = "archil" ]; then
    local config
    config=$(cat "$SCRIPT_DIR/disk-config.json")
    args+=(
      -e "ARCHIL_DISK_ID=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['diskId'])")"
      -e "ARCHIL_MOUNT_TOKEN=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['mountToken'])")"
      -e "ARCHIL_REGION=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['region'])")"
    )
  fi

  local machine_output
  machine_output=$(fly machine run "${args[@]}" 2>&1)
  local machine_id
  machine_id=$(echo "$machine_output" | grep "Machine ID:" | awk '{print $NF}')
  log "Machine $machine_id started"

  # Wait for it to finish
  fly machine wait "$machine_id" --app "$APP_NAME" --state stopped --timeout 600 2>&1 || true

  # Capture logs
  echo "### $mode" >> "$RESULTS_FILE"
  echo '```' >> "$RESULTS_FILE"
  fly logs --app "$APP_NAME" --no-tail 2>&1 \
    | grep "$machine_id" \
    | grep '\[bench:' \
    | sed 's/.*\[info\]//' \
    >> "$RESULTS_FILE"
  echo '```' >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"

  log "$mode complete"
}

# ── Main ──
echo "# Archil node_modules benchmark — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "Environment: Fly \`$REGION\` (London) — 4 shared vCPUs, 4 GB RAM" >> "$RESULTS_FILE"
echo "Archil disk: \`aws-eu-west-1\` (Ireland), backed by Cloudflare R2 (Western Europe)" >> "$RESULTS_FILE"
echo "Workload: \`pnpm install lodash chalk request commander express\` (114 packages, ~2200 files)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

run_scenario "baseline"
run_scenario "archil"

# ── Cleanup ──
log "Destroying app..."
fly apps destroy "$APP_NAME" --yes 2>&1 || true

log "Done. Results in $RESULTS_FILE"
cat "$RESULTS_FILE"
