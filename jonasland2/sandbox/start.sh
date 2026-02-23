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

wait_for_url() {
  url="$1"
  label="$2"
  max_attempts="${3:-120}"

  i=1
  while [ "$i" -le "$max_attempts" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done

  echo "$label failed health check: $url"
  exit 1
}

nomad agent -dev -config=/etc/jonasland2/nomad/base.hcl &
NOMAD_PID="$!"

stop_nomad() {
  kill "$NOMAD_PID" 2>/dev/null || true
}

trap stop_nomad INT TERM

until nomad status >/dev/null 2>&1; do
  sleep 1
done

nomad job run -detach /etc/jonasland2/nomad/jobs/consul.nomad.hcl
wait_for_url "http://127.0.0.1:8500/v1/status/leader" "consul" 240

printf 'nameserver 127.0.0.1\noptions ndots:0\n' > /etc/resolv.conf

nomad job run -detach /etc/jonasland2/nomad/jobs/openobserve.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/egress.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/events-service.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/caddy.nomad.hcl

wait_for_url "http://127.0.0.1:5080/healthz" "openobserve"
wait_for_url "http://127.0.0.1:19010/healthz" "events-service"
wait_for_url "http://127.0.0.1:80/healthz" "caddy"

wait "$NOMAD_PID"
