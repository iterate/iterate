#!/usr/bin/env sh
set -eu

NODE_UID="$(id -u node)"

ensure_rule() {
  table="$1"
  shift

  if iptables -t "$table" -C "$@" 2>/dev/null; then
    return 0
  fi

  iptables -t "$table" -A "$@"
}

ensure_rule nat OUTPUT -m owner --uid-owner "$NODE_UID" -j RETURN
ensure_rule nat OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 80
ensure_rule nat OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports 443

su-exec node /app/node_modules/.bin/tsx /app/apps/events-service/src/server.ts &
events_pid=$!

# Fail fast if events-service cannot boot.
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:19010/healthz >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$events_pid" 2>/dev/null; then
    echo "events-service exited during startup"
    exit 1
  fi

  sleep 0.25
done

su-exec node node /app/egress-server.mjs &
exec su-exec node caddy run --config /app/Caddyfile --adapter caddyfile
