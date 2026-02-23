#!/usr/bin/env sh
set -eu

CADDY_UID="$(id -u node)"

ensure_rule() {
  table="$1"
  shift

  if iptables -t "$table" -C "$@" 2>/dev/null; then
    return 0
  fi

  iptables -t "$table" -A "$@"
}

ensure_rule nat OUTPUT -m owner --uid-owner "$CADDY_UID" -j RETURN
ensure_rule nat OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 80
ensure_rule nat OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports 443

iptables -t nat -S
