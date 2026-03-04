#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"

if [[ -n "${DOCKER_HOST_SYNC_ENABLED:-}" ]]; then
  bash "${ITERATE_REPO}/jonasland/sandbox/providers/docker/sync-repo-from-host.sh"
fi

if [[ -f "${ITERATE_REPO}/jonasland/sandbox/sync-home-skeleton.sh" ]]; then
  bash "${ITERATE_REPO}/jonasland/sandbox/sync-home-skeleton.sh"
fi

# Useful for host-sync and startup readiness checks.
touch /tmp/reached-entrypoint

# Route DNS lookups through local dnsmasq.
# See jonasland/hosts-and-routing.md for details.
dnsmasq --conf-file=/etc/dnsmasq.d/iterate-localhost.conf
printf "nameserver 127.0.0.1\n" | sudo tee /etc/resolv.conf >/dev/null

for port in 80 443; do
  sudo iptables -t nat -C OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port" 2>/dev/null || \
    sudo iptables -t nat -A OUTPUT -p tcp --dport "$port" -j REDIRECT --to-ports "$port"
done

exec "$ITERATE_REPO/packages/pidnap/node_modules/.bin/tsx" \
  "$ITERATE_REPO/packages/pidnap/src/cli.ts" \
  init -c "$ITERATE_REPO/jonasland/sandbox/pidnap.config.ts"
