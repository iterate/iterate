#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
HANDLER_URL="${HANDLER_URL:-http://127.0.0.1:${VIEWER_PORT}/proxy}"
PROXIFY_CONFIG_DIR="${PROXIFY_CONFIG_DIR:-/data/proxify}"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

: >"$INIT_LOG"
: >"$MITM_LOG"

log "START host=$(hostname)"
mkdir -p "$PROXIFY_CONFIG_DIR"

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
bun run /proof/egress-proxy/server.ts >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"

MITM_PORT="$MITM_PORT" \
HANDLER_URL="$HANDLER_URL" \
PROXIFY_CONFIG_DIR="$PROXIFY_CONFIG_DIR" \
bash /proof/mitm-go/start.sh >>"$INIT_LOG" 2>&1 &
MITM_PID="$!"
log "mitm_pid=$MITM_PID"

for attempt in $(seq 1 60); do
  if \
    curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1 \
    && curl -fsS --max-time 2 --noproxy "" --proxy "http://127.0.0.1:${MITM_PORT}" "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then
    log "services_health=ok"
    log "READY mitm_port=${MITM_PORT} viewer_port=${VIEWER_PORT}"
    tail -f /dev/null
  fi

  if [ "$attempt" -eq 60 ]; then
    log "ERROR services_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done
