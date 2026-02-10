#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/sandbox-init.log"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"
EGRESS_MITM_PORT="${EGRESS_MITM_PORT:-18080}"
EGRESS_PROXY_HOST="${EGRESS_PROXY_HOST:-}"
EGRESS_PROXY_URL="${EGRESS_PROXY_URL:-}"
PROOF_ROOT="${PROOF_ROOT:-/proof}"
CA_CERT_PATH="${EGRESS_CA_CERT_PATH:-/tmp/iterate-fly-test-ca.crt}"
SKIP_PROXY_BOOTSTRAP="${SKIP_PROXY_BOOTSTRAP:-0}"

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
if [ "$SKIP_PROXY_BOOTSTRAP" != "1" ]; then
  if [ -z "$EGRESS_PROXY_URL" ]; then
    if [ -z "$EGRESS_PROXY_HOST" ]; then
      log "ERROR missing EGRESS_PROXY_URL and EGRESS_PROXY_HOST"
      exit 1
    fi
    EGRESS_PROXY_URL="http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}"
  fi

  log "START host=$(hostname) proxy=${EGRESS_PROXY_URL}"

  EGRESS_CA_URL="http://proxify/cacert"
  retry 20 curl -fsSL --proxy "$EGRESS_PROXY_URL" "$EGRESS_CA_URL" -o "$CA_CERT_PATH" >>"$INIT_LOG" 2>&1
  log "ca_fetch=ok source=${EGRESS_CA_URL} proxy=${EGRESS_PROXY_URL} cert_path=${CA_CERT_PATH}"

  export HTTP_PROXY="$EGRESS_PROXY_URL"
  export HTTPS_PROXY="$EGRESS_PROXY_URL"
  export http_proxy="$EGRESS_PROXY_URL"
  export https_proxy="$EGRESS_PROXY_URL"
  export NO_PROXY="localhost,127.0.0.1,::1"
  export no_proxy="localhost,127.0.0.1,::1"

  export NODE_EXTRA_CA_CERTS="$CA_CERT_PATH"
  export CURL_CA_BUNDLE="$CA_CERT_PATH"
  export REQUESTS_CA_BUNDLE="$CA_CERT_PATH"
  export GIT_SSL_CAINFO="$CA_CERT_PATH"

  log "proxy_env=${EGRESS_PROXY_URL}"
else
  log "START host=$(hostname) proxy_bootstrap=skip"
fi

SANDBOX_PORT="$SANDBOX_PORT" \
bun run "$PROOF_ROOT/sandbox/server.ts" >>"$INIT_LOG" 2>&1 &
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
