#!/bin/bash
set -euo pipefail

# Force Node runtimes in this sandbox to use the OS trust store so traffic
# intercepted by local Caddy (with its local CA) can be validated without
# disabling TLS verification.
if [[ -n "${NODE_OPTIONS:-}" ]]; then
  export NODE_OPTIONS="--use-openssl-ca ${NODE_OPTIONS}"
else
  export NODE_OPTIONS="--use-openssl-ca"
fi

for port in 80 443; do
  iptables -t nat -C OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port" 2>/dev/null || \
    iptables -t nat -A OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port"
done

exec /opt/pidnap/node_modules/.bin/tsx /opt/pidnap/src/cli.ts init -c /opt/jonasland-sandbox/pidnap.config.ts
