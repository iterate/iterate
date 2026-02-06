#!/bin/bash
set -euo pipefail

TUNNEL_PORTS_CSV="${DOCKER_CLOUDFLARE_TUNNEL_PORTS:-3000,3001,4096,9876}"
TUNNEL_STATE_DIR="/tmp/cloudflare-tunnels"
TUNNEL_LOG_DIR="/var/log/pidnap"

mkdir -p "$TUNNEL_STATE_DIR"
mkdir -p "$TUNNEL_LOG_DIR"

IFS=',' read -r -a ports <<< "$TUNNEL_PORTS_CSV"

for raw_port in "${ports[@]}"; do
  port="$(echo "$raw_port" | tr -d '[:space:]')"
  if [[ -z "$port" ]]; then
    continue
  fi
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "Invalid DOCKER_CLOUDFLARE_TUNNEL_PORTS value: $port" >&2
    exit 1
  fi

  log_file="$TUNNEL_LOG_DIR/cloudflared-${port}.log"
  url_file="$TUNNEL_STATE_DIR/${port}.url"
  pid_file="$TUNNEL_STATE_DIR/${port}.pid"

  rm -f "$url_file" "$pid_file"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" >"$log_file" 2>&1 &
  tunnel_pid=$!
  echo "$tunnel_pid" >"$pid_file"

  deadline=$((SECONDS + 45))
  tunnel_url=""
  while (( SECONDS < deadline )); do
    if ! kill -0 "$tunnel_pid" 2>/dev/null; then
      echo "cloudflared exited early for port ${port}" >&2
      tail -n 40 "$log_file" >&2 || true
      exit 1
    fi
    tunnel_url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$log_file" | tail -n 1 || true)"
    if [[ -n "$tunnel_url" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$tunnel_url" ]]; then
    echo "Timeout waiting for cloudflared URL for port ${port}" >&2
    tail -n 40 "$log_file" >&2 || true
    exit 1
  fi

  printf '%s' "$tunnel_url" >"$url_file"
done
