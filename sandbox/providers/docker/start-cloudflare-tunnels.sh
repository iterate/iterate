#!/bin/bash
set -euo pipefail

TUNNEL_PORTS_CSV="${DOCKER_TUNNEL_PORTS:-3000,3001,4096,9876}"
TUNNEL_STATE_DIR="/tmp/cloudflare-tunnels"
TUNNEL_LOG_DIR="/var/log/pidnap"
TUNNEL_MAX_ATTEMPTS=3
TUNNEL_URL_TIMEOUT_SECONDS=60

mkdir -p "$TUNNEL_STATE_DIR"
mkdir -p "$TUNNEL_LOG_DIR"

IFS=',' read -r -a ports <<< "$TUNNEL_PORTS_CSV"

for raw_port in "${ports[@]}"; do
  port="$(echo "$raw_port" | tr -d '[:space:]')"
  if [[ -z "$port" ]]; then
    continue
  fi
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "Invalid DOCKER_TUNNEL_PORTS value: $port" >&2
    exit 1
  fi

  log_file="$TUNNEL_LOG_DIR/cloudflared-${port}.log"
  url_file="$TUNNEL_STATE_DIR/${port}.url"
  pid_file="$TUNNEL_STATE_DIR/${port}.pid"

  attempt=1
  tunnel_url=""

  while (( attempt <= TUNNEL_MAX_ATTEMPTS )); do
    rm -f "$url_file" "$pid_file" "$log_file"
    cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" >"$log_file" 2>&1 &
    tunnel_pid=$!
    echo "$tunnel_pid" >"$pid_file"

    deadline=$((SECONDS + TUNNEL_URL_TIMEOUT_SECONDS))
    tunnel_url=""
    failed_early="false"

    while (( SECONDS < deadline )); do
      if ! kill -0 "$tunnel_pid" 2>/dev/null; then
        failed_early="true"
        break
      fi
      tunnel_url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$log_file" | tail -n 1 || true)"
      if [[ -n "$tunnel_url" ]]; then
        break
      fi
      sleep 1
    done

    if [[ -n "$tunnel_url" ]]; then
      printf '%s' "$tunnel_url" >"$url_file"
      break
    fi

    if kill -0 "$tunnel_pid" 2>/dev/null; then
      kill "$tunnel_pid" 2>/dev/null || true
      wait "$tunnel_pid" 2>/dev/null || true
    fi

    if (( attempt == TUNNEL_MAX_ATTEMPTS )); then
      if [[ "$failed_early" == "true" ]]; then
        echo "cloudflared exited early for port ${port}" >&2
      else
        echo "Timeout waiting for cloudflared URL for port ${port}" >&2
      fi
      tail -n 80 "$log_file" >&2 || true
      exit 1
    fi

    echo "Retrying cloudflared tunnel setup for port ${port} (attempt $((attempt + 1))/${TUNNEL_MAX_ATTEMPTS})" >&2
    attempt=$((attempt + 1))
    sleep 2
  done
done
