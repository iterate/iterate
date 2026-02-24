#!/bin/bash
set -euo pipefail

for port in 80 443; do
  iptables -t nat -C OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port" 2>/dev/null || \
    iptables -t nat -A OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port"
done

exec /opt/pidnap/node_modules/.bin/tsx /opt/pidnap/src/cli.ts init -c /etc/jonasland5/pidnap.config.ts
