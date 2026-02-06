#!/usr/bin/env bash
set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found" >&2
  exit 1
fi
if ! command -v dig >/dev/null 2>&1; then
  echo "dig not found" >&2
  exit 1
fi
if [ -z "${FLY_API_KEY:-}" ]; then
  echo "Missing FLY_API_KEY in env" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ORG="${FLY_ORG:-iterate}"
REGION="${FLY_REGION:-iad}"
APP="${APP_NAME:-iterate-node-egress-obsv-$(date +%m%d%H%M%S)}"
TARGET_URL="${TARGET_URL:-https://example.com/}"
ARTIFACT_DIR="$SCRIPT_DIR/proof-logs/$APP"
mkdir -p "$ARTIFACT_DIR"
export FLY_API_TOKEN="$FLY_API_KEY"

log() {
  printf "%s\n" "$*" | tee -a "$ARTIFACT_DIR/summary.txt"
}

machine_id_by_name() {
  local name="$1"
  flyctl machine list -a "$APP" --json | jq -r ".[] | select(.name==\"$name\") | .id" | head -n 1
}

machine_ip_by_name() {
  local name="$1"
  flyctl machine list -a "$APP" --json | jq -r ".[] | select(.name==\"$name\") | .private_ip" | head -n 1
}

fetch_url_with_dns_fallback() {
  local url="$1"
  local output_file="$2"
  local stderr_file="$3"
  local host
  local ip
  local attempt
  host="$(printf "%s\n" "$url" | sed -E 's#^https?://([^/]+)/?.*#\1#')"

  for attempt in $(seq 1 10); do
    if curl -fsS --max-time 25 "$url" >"$output_file" 2>"$stderr_file"; then
      return 0
    fi
    sleep 1
  done

  ip="$(dig +short "$host" @1.1.1.1 | head -n 1 || true)"
  if [ -z "$ip" ]; then
    return 1
  fi

  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 25 --resolve "${host}:443:${ip}" "$url" >"$output_file" 2>"$stderr_file"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

post_form_with_dns_fallback() {
  local url="$1"
  local data="$2"
  local output_file="$3"
  local stderr_file="$4"
  local host
  local ip
  local attempt

  host="$(printf "%s\n" "$url" | sed -E 's#^https?://([^/]+)/?.*#\1#')"

  for attempt in $(seq 1 10); do
    if curl -fsS --max-time 30 --data "$data" "$url" >"$output_file" 2>"$stderr_file"; then
      return 0
    fi
    sleep 1
  done

  ip="$(dig +short "$host" @1.1.1.1 | head -n 1 || true)"
  if [ -z "$ip" ]; then
    return 1
  fi

  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 30 --resolve "${host}:443:${ip}" --data "$data" "$url" >"$output_file" 2>"$stderr_file"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_machine_file() {
  local machine_id="$1"
  local remote_file="$2"
  local output_file="$3"
  local attempts
  for attempts in $(seq 1 150); do
    if flyctl machine exec "$machine_id" "cat $remote_file" -a "$APP" >"$output_file" 2>/dev/null; then
      if grep -Eq '^https://[-a-z0-9]+\.trycloudflare\.com$' "$output_file"; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

log "Creating app: $APP (org=$ORG region=$REGION)"
flyctl apps create "$APP" -o "$ORG" -y >"$ARTIFACT_DIR/app-create.log" 2>&1

log "Launching egress proxy/viewer machine (node:24)"
flyctl machine run node:24 /bin/bash /proof/start-egress-node.sh \
  -a "$APP" \
  -r "$REGION" \
  --name "egress-proxy" \
  --restart always \
  --detach \
  --file-local /proof/egress-proxy-and-viewer.mjs="$SCRIPT_DIR/egress-proxy-and-viewer.mjs" \
  --file-local /proof/start-egress-node.sh="$SCRIPT_DIR/start-egress-node.sh" \
  -e PROOF_REGION="$REGION" \
  >"$ARTIFACT_DIR/egress-machine-run.log" 2>&1

EGRESS_ID="$(machine_id_by_name egress-proxy)"
if [ -z "$EGRESS_ID" ]; then
  log "ERROR egress machine id not found"
  exit 1
fi
EGRESS_IP="$(machine_ip_by_name egress-proxy)"
if [ -z "$EGRESS_IP" ]; then
  log "ERROR egress machine private IP not found"
  exit 1
fi
EGRESS_PROXY_HOST="$EGRESS_IP"
if printf "%s" "$EGRESS_IP" | grep -q ":"; then
  EGRESS_PROXY_HOST="[$EGRESS_IP]"
fi
printf "%s\n" "$EGRESS_ID" >"$ARTIFACT_DIR/egress-machine-id.txt"
printf "%s\n" "$EGRESS_IP" >"$ARTIFACT_DIR/egress-machine-ip.txt"
log "Egress machine: id=$EGRESS_ID private_ip=$EGRESS_IP proxy_host=$EGRESS_PROXY_HOST"

log "Launching sandbox machine (node:24) wired to egress proxy"
flyctl machine run node:24 /bin/bash /proof/start-sandbox-node.sh \
  -a "$APP" \
  -r "$REGION" \
  --name "sandbox-ui" \
  --restart always \
  --detach \
  --file-local /proof/sandbox-ui.mjs="$SCRIPT_DIR/sandbox-ui.mjs" \
  --file-local /proof/start-sandbox-node.sh="$SCRIPT_DIR/start-sandbox-node.sh" \
  -e PROOF_REGION="$REGION" \
  -e EGRESS_PROXY_URL="http://${EGRESS_PROXY_HOST}:18080" \
  -e DEFAULT_TARGET_URL="$TARGET_URL" \
  >"$ARTIFACT_DIR/sandbox-machine-run.log" 2>&1

SANDBOX_ID="$(machine_id_by_name sandbox-ui)"
if [ -z "$SANDBOX_ID" ]; then
  log "ERROR sandbox machine id not found"
  exit 1
fi
printf "%s\n" "$SANDBOX_ID" >"$ARTIFACT_DIR/sandbox-machine-id.txt"
log "Sandbox machine: id=$SANDBOX_ID"

log "Waiting for cloudflared tunnel URLs from both machines"
if ! wait_for_machine_file "$EGRESS_ID" "/tmp/egress-viewer-tunnel-url.txt" "$ARTIFACT_DIR/egress-viewer-url.txt"; then
  log "ERROR egress viewer tunnel URL not ready"
  exit 1
fi
if ! wait_for_machine_file "$SANDBOX_ID" "/tmp/sandbox-tunnel-url.txt" "$ARTIFACT_DIR/sandbox-url.txt"; then
  log "ERROR sandbox tunnel URL not ready"
  exit 1
fi
EGRESS_VIEWER_URL="$(cat "$ARTIFACT_DIR/egress-viewer-url.txt")"
SANDBOX_URL="$(cat "$ARTIFACT_DIR/sandbox-url.txt")"
log "Egress viewer URL: $EGRESS_VIEWER_URL"
log "Sandbox URL: $SANDBOX_URL"

log "Checking both pages from host"
fetch_url_with_dns_fallback "$EGRESS_VIEWER_URL" "$ARTIFACT_DIR/egress-viewer-home.html" "$ARTIFACT_DIR/egress-viewer-home.stderr"
fetch_url_with_dns_fallback "$SANDBOX_URL" "$ARTIFACT_DIR/sandbox-home.html" "$ARTIFACT_DIR/sandbox-home.stderr"

ENCODED_TARGET="$(printf "%s" "$TARGET_URL" | jq -sRr @uri)"
log "Triggering outbound fetch via sandbox form: $TARGET_URL"
post_form_with_dns_fallback "${SANDBOX_URL}/fetch" "url=${ENCODED_TARGET}" "$ARTIFACT_DIR/sandbox-fetch-response.html" "$ARTIFACT_DIR/sandbox-fetch.stderr"

log "Collecting logs from both machines"
flyctl machine exec "$EGRESS_ID" "cat /tmp/egress-proxy.log" -a "$APP" >"$ARTIFACT_DIR/egress-proxy.log" 2>&1 || true
flyctl machine exec "$EGRESS_ID" "cat /tmp/egress-init.log" -a "$APP" >"$ARTIFACT_DIR/egress-init.log" 2>&1 || true
flyctl machine exec "$EGRESS_ID" "cat /tmp/egress-tunnel.log" -a "$APP" >"$ARTIFACT_DIR/egress-tunnel.log" 2>&1 || true
flyctl machine exec "$SANDBOX_ID" "cat /tmp/sandbox-ui.log" -a "$APP" >"$ARTIFACT_DIR/sandbox-ui.log" 2>&1 || true
flyctl machine exec "$SANDBOX_ID" "cat /tmp/sandbox-init.log" -a "$APP" >"$ARTIFACT_DIR/sandbox-init.log" 2>&1 || true
flyctl machine exec "$SANDBOX_ID" "cat /tmp/sandbox-tunnel.log" -a "$APP" >"$ARTIFACT_DIR/sandbox-tunnel.log" 2>&1 || true

if ! rg -q "FETCH_(OK|ERROR)" "$ARTIFACT_DIR/sandbox-ui.log"; then
  log "ERROR sandbox did not report fetch attempt"
  exit 1
fi
if ! rg -q "HTTP|CONNECT_OPEN|CONNECT_CLOSE" "$ARTIFACT_DIR/egress-proxy.log"; then
  log "ERROR egress proxy log does not show outbound proxy event"
  exit 1
fi

log "SUCCESS"
log "Open side-by-side:"
log "  sandbox: $SANDBOX_URL"
log "  egress viewer: $EGRESS_VIEWER_URL"
log "Artifacts: $ARTIFACT_DIR"
log "Tail egress log live:"
log "  doppler run --config dev -- bash fly-test/tail-egress-log.sh $APP egress-proxy"
log "Destroy when done:"
log "  doppler run --config dev -- sh -lc 'export FLY_API_TOKEN=\"\$FLY_API_KEY\"; flyctl apps destroy $APP -y'"
