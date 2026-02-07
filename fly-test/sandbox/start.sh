#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/sandbox-init.log"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"
EGRESS_MITM_PORT="${EGRESS_MITM_PORT:-18080}"
EGRESS_VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
EGRESS_PROXY_HOST="${EGRESS_PROXY_HOST:?missing EGRESS_PROXY_HOST}"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

retry() {
  local attempts="$1"
  shift
  local try=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$try" -ge "$attempts" ]; then
      return 1
    fi
    sleep 2
    try=$((try + 1))
  done
}

: >"$INIT_LOG"
log "START host=$(hostname) egress_host=$EGRESS_PROXY_HOST"

EGRESS_CA_URL="http://proxify/cacert"
retry 20 curl -fsSL --proxy "http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}" "$EGRESS_CA_URL" -o /usr/local/share/ca-certificates/iterate-fly-test-ca.crt >>"$INIT_LOG" 2>&1
update-ca-certificates >>"$INIT_LOG" 2>&1
log "ca_install=ok source=${EGRESS_CA_URL} proxy=http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}"

EGRESS_PROXY_URL="http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}"
export HTTP_PROXY="$EGRESS_PROXY_URL"
export HTTPS_PROXY="$EGRESS_PROXY_URL"
export http_proxy="$EGRESS_PROXY_URL"
export https_proxy="$EGRESS_PROXY_URL"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

export NODE_EXTRA_CA_CERTS="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export CURL_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export REQUESTS_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export GIT_SSL_CAINFO="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"

log "proxy_env=${EGRESS_PROXY_URL}"

PROOF_PREFIX_VALUE="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}"
PROOF_PREFIX="$(printf '%b' "$PROOF_PREFIX_VALUE")"

SANDBOX_PORT="$SANDBOX_PORT" \
PROOF_PREFIX="$PROOF_PREFIX" \
bun run /proof/sandbox/server.ts >>"$INIT_LOG" 2>&1 &
APP_PID="$!"
log "app_pid=$APP_PID"

for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${SANDBOX_PORT}/healthz" >/dev/null 2>&1; then
    log "sandbox_health=ok"
    log "READY sandbox_port=${SANDBOX_PORT}"
    tail -f /dev/null
  fi
  if [ "$attempt" -eq 40 ]; then
    log "ERROR sandbox_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done
