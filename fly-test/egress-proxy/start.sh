#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
TRANSFORM_URL="${TRANSFORM_URL:-http://127.0.0.1:${VIEWER_PORT}/transform}"
MITM_DIR="${MITM_DIR:-/data/mitm}"

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
      -subj "/CN=Iterate Fly Test Egress Root CA/O=Iterate/OU=fly-test" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" >>"$INIT_LOG" 2>&1
  fi
}

: >"$INIT_LOG"
: >"$MITM_LOG"

log "START host=$(hostname)"

generate_ca

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
MITM_CA_CERT_PATH="$MITM_DIR/ca.crt" \
bun run /proof/egress-proxy/server.ts >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"

MITM_PORT="$MITM_PORT" \
TRANSFORM_URL="$TRANSFORM_URL" \
MITM_CA_CERT="$MITM_DIR/ca.crt" \
MITM_CA_KEY="$MITM_DIR/ca.key" \
MITM_LOG="$MITM_LOG" \
bash /proof/mitm-go/start.sh >>"$INIT_LOG" 2>&1 &
MITM_PID="$!"
log "mitm_pid=$MITM_PID"

for attempt in $(seq 1 60); do
  if \
    curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1 \
    && curl -fsS --max-time 2 "http://127.0.0.1:${MITM_PORT}/healthz" >/dev/null 2>&1; then
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
