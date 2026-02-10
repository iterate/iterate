#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
HANDLER_URL="${HANDLER_URL:-http://127.0.0.1:${VIEWER_PORT}/proxy}"
PROXIFY_CONFIG_DIR="${PROXIFY_CONFIG_DIR:-/data/proxify}"
PROOF_ROOT="${PROOF_ROOT:-/proof}"
EGRESS_ENABLE_MITM="${EGRESS_ENABLE_MITM:-1}"
DATA_DIR="${EGRESS_DATA_DIR:-/data}"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

: >"$INIT_LOG"
: >"$MITM_LOG"

log "START host=$(hostname)"
mkdir -p "$PROXIFY_CONFIG_DIR"
mkdir -p "$DATA_DIR"

# Bootstrap default secrets.json if not present, resolving env vars
if [ ! -f "$DATA_DIR/secrets.json" ]; then
  log "Bootstrapping default secrets.json"
  envsubst < "$PROOF_ROOT/egress-proxy/default-secrets.json" > "$DATA_DIR/secrets.json"
fi

# Bootstrap default policies.json if not present
if [ ! -f "$DATA_DIR/policies.json" ]; then
  log "Bootstrapping default policies.json"
  cp "$PROOF_ROOT/egress-proxy/default-policies.json" "$DATA_DIR/policies.json"
fi

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
EGRESS_DATA_DIR="$DATA_DIR" \
bun run "$PROOF_ROOT/egress-proxy/server.ts" >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"
PIDS=("$VIEWER_PID")

if [ "$EGRESS_ENABLE_MITM" = "1" ]; then
  MITM_PORT="$MITM_PORT" \
  HANDLER_URL="$HANDLER_URL" \
  PROXIFY_CONFIG_DIR="$PROXIFY_CONFIG_DIR" \
  bash "$PROOF_ROOT/mitm-go/start.sh" >>"$INIT_LOG" 2>&1 &
  MITM_PID="$!"
  log "mitm_pid=$MITM_PID"
  PIDS+=("$MITM_PID")
else
  log "mitm=disabled"
fi

cleanup() {
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait "${PIDS[@]}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

services_ready=0
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then
    if [ "$EGRESS_ENABLE_MITM" = "1" ]; then
      if ! curl -fsS --max-time 2 --noproxy "" --proxy "http://127.0.0.1:${MITM_PORT}" "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then
        sleep 1
        continue
      fi
    fi
    log "services_health=ok"
    log "READY mitm_port=${MITM_PORT} viewer_port=${VIEWER_PORT}"
    services_ready=1
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    log "ERROR services_health=fail"
  fi
  sleep 1
done

if [ "$services_ready" -ne 1 ]; then
  exit 1
fi

while true; do
  if wait -n "${PIDS[@]}"; then
    exit_code=0
  else
    exit_code=$?
  fi
  log "ERROR child_process_exited exit_code=${exit_code}"
  exit 1
done
