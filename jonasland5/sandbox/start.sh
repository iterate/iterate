#!/bin/sh
set -eu

nomad agent -dev -config=/etc/jonasland5/nomad/base.hcl &
NOMAD_PID="$!"

stop_nomad() {
  kill "$NOMAD_PID" 2>/dev/null || true
}

trap stop_nomad INT TERM

until nomad status >/dev/null 2>&1; do
  sleep 1
done

nomad job run /etc/jonasland5/nomad/jobs/consul.nomad.hcl
until curl -fsS http://127.0.0.1:8500/v1/status/leader >/dev/null 2>&1; do
  sleep 1
done

until nomad node status -self -verbose 2>/dev/null | grep -q "consul.version"; do
  sleep 1
done

printf 'nameserver 127.0.0.1\noptions ndots:0\n' > /etc/resolv.conf

nomad job run /etc/jonasland5/nomad/jobs/caddy.nomad.hcl
until curl -fsS http://127.0.0.1:80 >/dev/null 2>&1; do
  sleep 1
done

nomad job run /etc/jonasland5/nomad/jobs/caddymanager.nomad.hcl
until curl -fsS http://127.0.0.1:8501 >/dev/null 2>&1; do
  sleep 1
done
until curl -fsS http://127.0.0.1:8501/api/v1/health >/dev/null 2>&1; do
  sleep 1
done

/etc/jonasland5/scripts/bootstrap-caddymanager.sh

wait "$NOMAD_PID"
