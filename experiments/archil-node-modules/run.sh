#!/bin/bash
# Run a single benchmark scenario, saving raw logs to raw-logs/.
#
# Usage:
#   doppler run -- ./run.sh fly    local-disk  small-workload
#   doppler run -- ./run.sh fly    archil-disk medium-workload
#   doppler run -- ./run.sh docker local-disk  small-workload
#   doppler run -- ./run.sh docker archil-disk medium-workload
#
# Run all (except macbook+archil+medium which is extremely slow):
#   doppler run -- ./run.sh fly    local-disk  small-workload
#   doppler run -- ./run.sh fly    local-disk  medium-workload
#   doppler run -- ./run.sh fly    archil-disk small-workload
#   doppler run -- ./run.sh fly    archil-disk medium-workload
#   doppler run -- ./run.sh docker local-disk  small-workload
#   doppler run -- ./run.sh docker local-disk  medium-workload
#   doppler run -- ./run.sh docker archil-disk small-workload
#
# Tuning variants (set LOG_SUFFIX to avoid overwriting baseline logs):
#   LOG_SUFFIX=eatmydata       USE_EATMYDATA=1                  doppler run -- ./run.sh fly archil-disk small-workload
#   LOG_SUFFIX=writeback-cache  ARCHIL_MOUNT_OPTS="--writeback-cache" doppler run -- ./run.sh fly archil-disk small-workload
#   LOG_SUFFIX=nconnect4        ARCHIL_MOUNT_OPTS="--nconnect 4" doppler run -- ./run.sh fly archil-disk small-workload
#
# Then generate results.md:
#   ./generate-results.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RAW_LOGS_DIR="$SCRIPT_DIR/raw-logs"
IMAGE_TAG="archil-bench-$(date +%s)"
IMAGE="registry.fly.io/iterate-sandbox:${IMAGE_TAG}"
FLY_APP="archil-bench-exp"
FLY_REGION="lhr"

MACHINE="${1:?Usage: ./run.sh <fly|docker> <local-disk|archil-disk> <small-workload|medium-workload>}"
DISK="${2:?Usage: ./run.sh <fly|docker> <local-disk|archil-disk> <small-workload|medium-workload>}"
WORKLOAD="${3:?Usage: ./run.sh <fly|docker> <local-disk|archil-disk> <small-workload|medium-workload>}"

SCENARIO="${MACHINE}-${DISK}-${WORKLOAD}"
# Optional suffix to distinguish tuning variants (e.g. LOG_SUFFIX=eatmydata)
if [ -n "${LOG_SUFFIX:-}" ]; then
  SCENARIO="${SCENARIO}-${LOG_SUFFIX}"
fi
LOG_FILE="$RAW_LOGS_DIR/${SCENARIO}.log"

log() { echo "==> $*"; }

mkdir -p "$RAW_LOGS_DIR"

# ── Resolve MODE and WORKLOAD_KEY from args ──
case "$DISK" in
  local-disk)  MODE="baseline" ;;
  archil-disk) MODE="archil" ;;
  *) echo "Unknown disk: $DISK (expected local-disk|archil-disk)"; exit 1 ;;
esac
case "$WORKLOAD" in
  small-workload)  WORKLOAD_KEY="small" ;;
  medium-workload) WORKLOAD_KEY="medium" ;;
  *) echo "Unknown workload: $WORKLOAD (expected small-workload|medium-workload)"; exit 1 ;;
esac

# ── Read Archil disk config (if needed) ──
ARCHIL_DISK_ID="" ARCHIL_MOUNT_TOKEN="" ARCHIL_REGION=""
if [ "$MODE" = "archil" ]; then
  config=$(cat "$SCRIPT_DIR/disk-config.json")
  ARCHIL_DISK_ID=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['diskId'])")
  ARCHIL_MOUNT_TOKEN=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['mountToken'])")
  ARCHIL_REGION=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['nm']['region'])")
fi

# ══════════════════════════════════════════════════════════════════════════════
# Fly scenario
# ══════════════════════════════════════════════════════════════════════════════
run_fly() {
  log "[$SCENARIO] Building and pushing image..."
  docker buildx build --platform linux/amd64 \
    -t "$IMAGE" --push "$SCRIPT_DIR" 2>&1 | tail -3

  fly apps create "$FLY_APP" --org iterate 2>/dev/null || true

  log "[$SCENARIO] Starting Fly machine..."

  local args=(
    "$IMAGE"
    --app "$FLY_APP"
    --region "$FLY_REGION"
    --vm-cpus 4 --vm-memory 4096 --vm-cpu-kind shared
    -e "MODE=$MODE"
    -e "WORKLOAD=$WORKLOAD_KEY"
  )

  if [ "$MODE" = "archil" ]; then
    args+=(
      -e "ARCHIL_DISK_ID=$ARCHIL_DISK_ID"
      -e "ARCHIL_MOUNT_TOKEN=$ARCHIL_MOUNT_TOKEN"
      -e "ARCHIL_REGION=$ARCHIL_REGION"
    )
    [ -n "${ARCHIL_MOUNT_OPTS:-}" ] && args+=(-e "ARCHIL_MOUNT_OPTS=$ARCHIL_MOUNT_OPTS")
    [ -n "${USE_EATMYDATA:-}" ] && args+=(-e "USE_EATMYDATA=$USE_EATMYDATA")
  fi

  local machine_output machine_id
  machine_output=$(fly machine run "${args[@]}" 2>&1)
  machine_id=$(echo "$machine_output" | grep "Machine ID:" | awk '{print $NF}')
  log "[$SCENARIO] Machine $machine_id started"

  # Poll for machine to stop (fly machine wait removed in newer fly CLI)
  log "[$SCENARIO] Waiting for machine $machine_id to stop..."
  local waited=0
  while true; do
    local state
    state=$(fly machine status "$machine_id" -a "$FLY_APP" 2>/dev/null | awk '/State/ {print $NF; exit}')
    if [ "$state" = "stopped" ] || [ "$state" = "destroyed" ]; then
      break
    fi
    sleep 10
    waited=$((waited + 10))
    if [ $waited -ge 1800 ]; then
      log "[$SCENARIO] Timed out waiting for machine"
      break
    fi
  done

  fly logs --app "$FLY_APP" --no-tail 2>&1 \
    | grep "$machine_id" \
    | grep '\[bench:' \
    | sed 's/.*\[info\]//' \
    > "$LOG_FILE"

  log "[$SCENARIO] Complete — saved to $LOG_FILE"
  cat "$LOG_FILE"
}

# ══════════════════════════════════════════════════════════════════════════════
# Docker (local) scenario
# ══════════════════════════════════════════════════════════════════════════════
run_docker() {
  log "[$SCENARIO] Building local Docker image..."
  docker build -t archil-bench-local "$SCRIPT_DIR" 2>&1 | tail -3

  log "[$SCENARIO] Starting local Docker container..."

  local docker_args=(
    --rm
    --privileged
    -e "MODE=$MODE"
    -e "WORKLOAD=$WORKLOAD_KEY"
  )

  if [ "$MODE" = "archil" ]; then
    docker_args+=(
      -e "ARCHIL_DISK_ID=$ARCHIL_DISK_ID"
      -e "ARCHIL_MOUNT_TOKEN=$ARCHIL_MOUNT_TOKEN"
      -e "ARCHIL_REGION=$ARCHIL_REGION"
    )
    [ -n "${ARCHIL_MOUNT_OPTS:-}" ] && docker_args+=(-e "ARCHIL_MOUNT_OPTS=$ARCHIL_MOUNT_OPTS")
    [ -n "${USE_EATMYDATA:-}" ] && docker_args+=(-e "USE_EATMYDATA=$USE_EATMYDATA")
  fi

  docker run "${docker_args[@]}" archil-bench-local 2>&1 \
    | grep '\[bench:' \
    > "$LOG_FILE"

  log "[$SCENARIO] Complete — saved to $LOG_FILE"
  cat "$LOG_FILE"
}

# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════
case "$MACHINE" in
  fly)    run_fly ;;
  docker) run_docker ;;
  *) echo "Unknown machine: $MACHINE (expected fly|docker)"; exit 1 ;;
esac
