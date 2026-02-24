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

wait_for_consul_service() {
  service_name="$1"
  max_attempts="${2:-120}"

  i=1
  while [ "$i" -le "$max_attempts" ]; do
    if curl -fsS "http://127.0.0.1:8500/v1/health/service/${service_name}?passing=1" \
      | grep -q "\"ServiceName\":\"${service_name}\""; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done

  echo "consul service failed health check: ${service_name}"
  exit 1
}

wait_for_caddy_egress_route() {
  max_attempts="${1:-120}"

  i=1
  while [ "$i" -le "$max_attempts" ]; do
    status_code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H 'Host: egress-probe.iterate.localhost' \
      'http://127.0.0.1/__egress_probe' || true)"
    if [ "$status_code" != "503" ] && [ "$status_code" != "000" ]; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done

  echo "caddy fallback egress route failed readiness check"
  exit 1
}

wait_for_caddy_egress_route_tls() {
  max_attempts="${1:-120}"

  i=1
  while [ "$i" -le "$max_attempts" ]; do
    status_code="$(curl -k -sS -o /dev/null -w '%{http_code}' \
      -H 'Host: upstream.iterate.localhost' \
      'https://127.0.0.1/__egress_probe' || true)"
    if [ "$status_code" != "503" ] && [ "$status_code" != "000" ]; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done

  echo "caddy TLS fallback egress route failed readiness check"
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
nomad job run -detach /etc/jonasland2/nomad/jobs/otel-collector.nomad.hcl
nomad job run \
  -detach \
  -var "external_egress_proxy=${ITERATE_EXTERNAL_EGRESS_PROXY:-}" \
  /etc/jonasland2/nomad/jobs/egress.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/events-service.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/orders-service.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/outerbase-studio.nomad.hcl
nomad job run -detach /etc/jonasland2/nomad/jobs/caddy.nomad.hcl

wait_for_url "http://127.0.0.1:5080/healthz" "openobserve"
wait_for_url "http://127.0.0.1:13133/" "otel-collector"
wait_for_url "http://127.0.0.1:19000/healthz" "egress-proxy"
wait_for_url "http://127.0.0.1:19010/healthz" "events-service"
wait_for_url "http://127.0.0.1:19020/healthz" "orders-service"
wait_for_url "http://127.0.0.1:19040/" "outerbase-studio"
wait_for_consul_service "events-service"
wait_for_consul_service "orders-service"
wait_for_consul_service "outerbase-studio"
wait_for_url "http://127.0.0.1:80/healthz" "caddy"
wait_for_url "http://127.0.0.1:2019/config/" "caddy-admin"
wait_for_caddy_egress_route
wait_for_caddy_egress_route_tls

wait "$NOMAD_PID"
