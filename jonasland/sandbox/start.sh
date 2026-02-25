#!/bin/bash
set -euo pipefail

for ipt in iptables ip6tables; do
  for port in 80 443; do
    "$ipt" -t nat -C OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port" 2>/dev/null || \
      "$ipt" -t nat -A OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port"
  done
done

exec /opt/pidnap/node_modules/.bin/tsx /opt/pidnap/src/cli.ts init -c /opt/jonasland-sandbox/pidnap.config.ts
