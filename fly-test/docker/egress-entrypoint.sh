#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
FORWARD_PORT="${EGRESS_FORWARD_PORT:-18082}"
TRANSFORM_URL="${TRANSFORM_URL:-http://127.0.0.1:${VIEWER_PORT}/transform}"
MITM_DIR="${MITM_DIR:-/data/mitm}"
MITM_IMPL="${MITM_IMPL:-go}"
APP_DIR="/proof/egress-proxy"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

generate_ca() {
  mkdir -p "$MITM_DIR"
  if [ ! -f "$MITM_DIR/ca.crt" ] || [ ! -f "$MITM_DIR/ca.key" ]; then
    log "generating_ca_cert dir=$MITM_DIR"
    openssl ecparam -name prime256v1 -genkey -noout -out "$MITM_DIR/ca.key" >>"$INIT_LOG" 2>&1
    openssl req -x509 -new -sha256 \
      -key "$MITM_DIR/ca.key" \
      -out "$MITM_DIR/ca.crt" \
      -days 3650 \
      -subj "/CN=Iterate Docker Test Egress Root CA/O=Iterate/OU=fly-test" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" >>"$INIT_LOG" 2>&1
  else
    log "ca_cert_already_exists"
  fi
}

: >"$INIT_LOG"
: >"$MITM_LOG"
log "START host=$(hostname)"

generate_ca

cd "$APP_DIR"
if [ ! -d "$APP_DIR/node_modules" ]; then
  log "ERROR missing_node_modules path=$APP_DIR/node_modules"
  tail -f /dev/null
fi

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
EGRESS_FORWARD_PORT="$FORWARD_PORT" \
MITM_CA_CERT_PATH="$MITM_DIR/ca.crt" \
PROOF_PREFIX="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}" \
bun run "$APP_DIR/server.ts" >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"

if [ "$MITM_IMPL" = "go" ]; then
  MITM_PORT="$MITM_PORT" \
  TRANSFORM_URL="$TRANSFORM_URL" \
  MITM_CA_CERT="$MITM_DIR/ca.crt" \
  MITM_CA_KEY="$MITM_DIR/ca.key" \
  MITM_LOG="$MITM_LOG" \
  bash /proof/mitm-go/start.sh >>"$INIT_LOG" 2>&1 &
elif [ "$MITM_IMPL" = "dump" ]; then
  MITM_PORT="$MITM_PORT" \
  FORWARD_PORT="$FORWARD_PORT" \
  MITM_DIR="$MITM_DIR" \
  bash /proof/mitm-dump/start.sh >>"$INIT_LOG" 2>&1 &
else
  log "ERROR invalid_mitm_impl value=$MITM_IMPL expected=go|dump"
  tail -f /dev/null
fi
MITM_PID="$!"
log "mitm_pid=$MITM_PID mitm_impl=$MITM_IMPL"

for attempt in $(seq 1 60); do
  viewer_ok="0"
  mitm_ok="0"
  if curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then viewer_ok="1"; fi
  if [ "$MITM_IMPL" = "go" ]; then
    if curl -fsS --max-time 2 "http://127.0.0.1:${MITM_PORT}/healthz" >/dev/null 2>&1; then mitm_ok="1"; fi
  else
    if curl -sS --max-time 2 "http://127.0.0.1:${MITM_PORT}" >/dev/null 2>&1; then mitm_ok="1"; fi
  fi

  if [ "$viewer_ok" = "1" ] && [ "$mitm_ok" = "1" ]; then
    log "services_health=ok"
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    log "ERROR services_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done

log "READY mitm_port=${MITM_PORT} viewer_port=${VIEWER_PORT}"
tail -f /dev/null
