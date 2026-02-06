#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
TUNNEL_LOG="/tmp/egress-tunnel.log"
TUNNEL_URL_FILE="/tmp/egress-viewer-tunnel-url.txt"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
TRANSFORM_URL="${TRANSFORM_URL:-http://127.0.0.1:${VIEWER_PORT}/transform}"
MITM_DIR="${MITM_DIR:-/data/mitm}"
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
      -subj "/CN=Iterate Fly Test Egress Root CA/O=Iterate/OU=fly-test" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" >>"$INIT_LOG" 2>&1
  else
    log "ca_cert_already_exists"
  fi
}

wait_for_tunnel_url() {
  local attempts
  for attempts in $(seq 1 120); do
    local tunnel_url
    tunnel_url="$(grep -Eo "https://[-a-z0-9]+\\.trycloudflare\\.com" "$TUNNEL_LOG" | head -n 1 || true)"
    if [ -n "$tunnel_url" ]; then
      printf "%s\n" "$tunnel_url" >"$TUNNEL_URL_FILE"
      log "viewer_tunnel_url=$tunnel_url"
      return 0
    fi
    sleep 1
  done
  return 1
}

: >"$INIT_LOG"
: >"$MITM_LOG"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"

if [ ! -x "/usr/local/bin/fly-mitm" ]; then
  log "ERROR missing_mitm_binary path=/usr/local/bin/fly-mitm"
  tail -f /dev/null
fi

if ! command -v bun >/dev/null 2>&1; then
  log "ERROR bun_not_found"
  tail -f /dev/null
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  log "ERROR cloudflared_not_found"
  tail -f /dev/null
fi
if ! command -v openssl >/dev/null 2>&1; then
  log "ERROR openssl_not_found"
  tail -f /dev/null
fi
bun --version >>"$INIT_LOG" 2>&1 || true
cloudflared --version >>"$INIT_LOG" 2>&1 || true

generate_ca

cd "$APP_DIR"
if [ ! -d "$APP_DIR/node_modules" ]; then
  log "ERROR missing_node_modules path=$APP_DIR/node_modules"
  tail -f /dev/null
fi

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
MITM_CA_CERT_PATH="$MITM_DIR/ca.crt" \
PROOF_PREFIX="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}" \
bun run "$APP_DIR/server.ts" >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"

/usr/local/bin/fly-mitm \
  --listen ":${MITM_PORT}" \
  --transform-url "$TRANSFORM_URL" \
  --ca-cert "$MITM_DIR/ca.crt" \
  --ca-key "$MITM_DIR/ca.key" \
  --log "$MITM_LOG" \
  --request-preview-bytes "${REQUEST_PREVIEW_BYTES:-512}" >>"$INIT_LOG" 2>&1 &
MITM_PID="$!"
log "mitm_pid=$MITM_PID"

for attempt in $(seq 1 60); do
  viewer_ok="0"
  mitm_ok="0"
  if curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then viewer_ok="1"; fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${MITM_PORT}/healthz" >/dev/null 2>&1; then mitm_ok="1"; fi

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

cloudflared tunnel --url "http://127.0.0.1:${VIEWER_PORT}" --no-autoupdate --loglevel info >"$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID="$!"
log "cloudflared_pid=$CLOUDFLARED_PID"

if ! wait_for_tunnel_url; then
  log "ERROR tunnel_url_not_found"
  tail -f /dev/null
fi

log "READY mitm_port=${MITM_PORT} viewer_port=${VIEWER_PORT}"
tail -f /dev/null
