#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/sandbox-init.log"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"
EGRESS_VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
EGRESS_MITM_PORT="${EGRESS_MITM_PORT:-18080}"
MITM_IMPL="${MITM_IMPL:-go}"
EGRESS_GATEWAY_IP="${EGRESS_GATEWAY_IP:?missing EGRESS_GATEWAY_IP}"
EGRESS_VIEWER_HOST="${EGRESS_VIEWER_HOST:-egress-proxy}"
EGRESS_PROXY_HOST="${EGRESS_PROXY_HOST:-$EGRESS_GATEWAY_IP}"
APP_DIR="/proof/sandbox"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

retry() {
  local attempts="$1"
  shift
  local try=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$try" -ge "$attempts" ]; then
      return 1
    fi
    sleep "$delay"
    try=$((try + 1))
    delay=$((delay * 2))
    if [ "$delay" -gt 20 ]; then delay=20; fi
  done
}

: >"$INIT_LOG"
log "START host=$(hostname) gateway=${EGRESS_GATEWAY_IP} viewer_host=${EGRESS_VIEWER_HOST}"

EGRESS_CA_URL="http://${EGRESS_VIEWER_HOST}:${EGRESS_VIEWER_PORT}/ca.crt"
retry 20 curl -fsSL "$EGRESS_CA_URL" -o /usr/local/share/ca-certificates/iterate-docker-ca.crt >>"$INIT_LOG" 2>&1
update-ca-certificates >>"$INIT_LOG" 2>&1
log "ca_install=ok source=${EGRESS_CA_URL}"

# Route outbound traffic through gateway; Go mode also sets explicit proxy env.
EGRESS_PROXY_URL="http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}"
if [ "$MITM_IMPL" = "go" ]; then
  export HTTP_PROXY="$EGRESS_PROXY_URL"
  export HTTPS_PROXY="$EGRESS_PROXY_URL"
  export http_proxy="$EGRESS_PROXY_URL"
  export https_proxy="$EGRESS_PROXY_URL"
  export NO_PROXY="localhost,127.0.0.1,::1"
  export no_proxy="localhost,127.0.0.1,::1"
else
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
fi
export NODE_EXTRA_CA_CERTS="/usr/local/share/ca-certificates/iterate-docker-ca.crt"
export CURL_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-docker-ca.crt"
export REQUESTS_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-docker-ca.crt"
export GIT_SSL_CAINFO="/usr/local/share/ca-certificates/iterate-docker-ca.crt"

OLD_DEFAULT="$(ip route show default | head -n 1 || true)"
if [ -n "$OLD_DEFAULT" ]; then
  OLD_GW="$(echo "$OLD_DEFAULT" | awk '{print $3}')"
  if [ -n "$OLD_GW" ] && [ "$OLD_GW" != "$EGRESS_GATEWAY_IP" ]; then
    ip route replace default via "$EGRESS_GATEWAY_IP" dev eth0
  fi
fi

ip route show > /tmp/sandbox-routes.txt
log "transparent_redirect=enabled default_gw=${EGRESS_GATEWAY_IP}"
if [ "$MITM_IMPL" = "go" ]; then
  log "proxy_env=${EGRESS_PROXY_URL}"
else
  log "proxy_env=disabled mitm_impl=${MITM_IMPL}"
fi

cd "$APP_DIR"
if [ ! -d "$APP_DIR/node_modules" ]; then
  log "ERROR missing_node_modules path=$APP_DIR/node_modules"
  tail -f /dev/null
fi

SANDBOX_PORT="$SANDBOX_PORT" \
PROOF_PREFIX="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}" \
bun run "$APP_DIR/server.ts" >>"$INIT_LOG" 2>&1 &
APP_PID="$!"
log "app_pid=$APP_PID"

for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${SANDBOX_PORT}/healthz" >/dev/null 2>&1; then
    log "sandbox_health=ok"
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    log "ERROR sandbox_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done

log "READY sandbox_port=${SANDBOX_PORT}"
tail -f /dev/null
