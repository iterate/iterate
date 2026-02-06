#!/usr/bin/env bash
set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found in PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found in PATH" >&2
  exit 1
fi

if ! command -v dig >/dev/null 2>&1; then
  echo "dig not found in PATH" >&2
  exit 1
fi

if [ -z "${FLY_API_KEY:-}" ]; then
  echo "Missing FLY_API_KEY in env" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ORG="${FLY_ORG:-iterate}"
REGION="${FLY_REGION:-iad}"
APP="${APP_NAME:-iterate-cloudflared-e2e-$(date +%m%d%H%M%S)}"
MACHINE_NAME="cloudflared-e2e"
ARTIFACT_DIR="$SCRIPT_DIR/proof-logs/$APP"
mkdir -p "$ARTIFACT_DIR"

export FLY_API_TOKEN="$FLY_API_KEY"

log() {
  printf "%s\n" "$*" | tee -a "$ARTIFACT_DIR/summary.txt"
}

verify_from_host() {
  local tunnel_url="$1"
  local tunnel_host
  local tunnel_ip
  local attempt

  tunnel_host="$(printf "%s\n" "$tunnel_url" | sed -E "s#^https://([^/]+)/?.*#\\1#")"

  for attempt in $(seq 1 12); do
    if curl -fsS --max-time 20 "$tunnel_url" >"$ARTIFACT_DIR/local-response.txt" 2>"$ARTIFACT_DIR/local-curl.stderr"; then
      log "Host verify succeeded with system DNS (attempt=$attempt)"
      return 0
    fi
    sleep 2
  done

  tunnel_ip="$(dig +short "$tunnel_host" @1.1.1.1 | head -n 1 || true)"
  if [ -z "$tunnel_ip" ]; then
    log "ERROR DNS lookup failed for $tunnel_host via 1.1.1.1"
    return 1
  fi
  printf "%s\n" "$tunnel_ip" >"$ARTIFACT_DIR/tunnel-host-ip.txt"
  log "System DNS failed; retrying with forced resolve ${tunnel_host}:443:${tunnel_ip}"

  for attempt in $(seq 1 12); do
    if curl -fsS --max-time 20 --resolve "${tunnel_host}:443:${tunnel_ip}" "$tunnel_url" >"$ARTIFACT_DIR/local-response.txt" 2>"$ARTIFACT_DIR/local-curl.stderr"; then
      log "Host verify succeeded with --resolve (attempt=$attempt)"
      return 0
    fi
    sleep 2
  done

  return 1
}

collect_artifacts() {
  local machine_id="$1"
  flyctl machine exec "$machine_id" "cat /tmp/cloudflared-e2e.log" -a "$APP" >"$ARTIFACT_DIR/machine.log" 2>&1 || true
  flyctl machine exec "$machine_id" "cat /tmp/cloudflared-tunnel.log" -a "$APP" >"$ARTIFACT_DIR/tunnel.log" 2>&1 || true
  flyctl machine exec "$machine_id" "cat /tmp/tunnel-url.txt" -a "$APP" >"$ARTIFACT_DIR/tunnel-url.txt" 2>&1 || true
  flyctl machine exec "$machine_id" "cat /tmp/web/index.html" -a "$APP" >"$ARTIFACT_DIR/web-index.txt" 2>&1 || true
}

log "Creating app: $APP (org=$ORG, region=$REGION)"
flyctl apps create "$APP" -o "$ORG" -y >"$ARTIFACT_DIR/app-create.log" 2>&1

log "Launching machine and installing cloudflared inside it"
flyctl machine run ubuntu:22.04 /bin/bash /proof/cloudflared-machine-init.sh \
  -a "$APP" \
  -r "$REGION" \
  --name "$MACHINE_NAME" \
  --restart always \
  --detach \
  --file-local /proof/cloudflared-machine-init.sh="$SCRIPT_DIR/cloudflared-machine-init.sh" \
  -e PROOF_REGION="$REGION" \
  >"$ARTIFACT_DIR/machine-run.log" 2>&1

MACHINE_ID="$(flyctl machine list -a "$APP" --json | jq -r ".[] | select(.name==\"$MACHINE_NAME\") | .id" | head -n 1)"
if [ -z "$MACHINE_ID" ]; then
  log "ERROR could not find machine id"
  exit 1
fi
printf "%s\n" "$MACHINE_ID" >"$ARTIFACT_DIR/machine-id.txt"
log "Machine id: $MACHINE_ID"

log "Waiting for tunnel URL from machine"
TUNNEL_URL=""
for attempt in $(seq 1 120); do
  set +e
  maybe_url="$(flyctl machine exec "$MACHINE_ID" "cat /tmp/tunnel-url.txt" -a "$APP" 2>/dev/null | tr -d '\r' | tail -n 1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && echo "$maybe_url" | grep -Eq "^https://[-a-z0-9]+\\.trycloudflare\\.com$"; then
    TUNNEL_URL="$maybe_url"
    break
  fi
  sleep 2
done

if [ -z "$TUNNEL_URL" ]; then
  collect_artifacts "$MACHINE_ID"
  log "ERROR tunnel URL not ready; see $ARTIFACT_DIR"
  exit 1
fi

printf "%s\n" "$TUNNEL_URL" >"$ARTIFACT_DIR/tunnel-url-from-host.txt"
log "Tunnel URL: $TUNNEL_URL"

log "Verifying from host: curl tunnel URL"
if ! verify_from_host "$TUNNEL_URL"; then
  collect_artifacts "$MACHINE_ID"
  log "ERROR host verification failed; see $ARTIFACT_DIR/local-curl.stderr"
  exit 1
fi

if ! grep -q "cloudflared-e2e-ok" "$ARTIFACT_DIR/local-response.txt"; then
  collect_artifacts "$MACHINE_ID"
  log "ERROR tunnel response missing marker; see $ARTIFACT_DIR/local-response.txt"
  exit 1
fi

collect_artifacts "$MACHINE_ID"
log "SUCCESS e2e check passed"
log "Artifacts: $ARTIFACT_DIR"
log "App left running for inspection: $APP"
log "Destroy when done: flyctl apps destroy $APP -y"
