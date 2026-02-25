#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

for port in 80 443; do
  sudo iptables -t nat -C OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port" 2>/dev/null || \
    sudo iptables -t nat -A OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port"
done

exec "$ITERATE_REPO/packages/pidnap/node_modules/.bin/tsx" \
  "$ITERATE_REPO/packages/pidnap/src/cli.ts" \
  init -c "$ITERATE_REPO/jonasland/sandbox/pidnap.config.ts"
