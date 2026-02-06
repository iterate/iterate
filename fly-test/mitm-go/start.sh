#!/usr/bin/env bash
set -euo pipefail

MITM_PORT="${MITM_PORT:-18080}"
TRANSFORM_URL="${TRANSFORM_URL:-http://127.0.0.1:18081}"
MITM_CA_CERT="${MITM_CA_CERT:-/data/mitm/ca.crt}"
MITM_CA_KEY="${MITM_CA_KEY:-/data/mitm/ca.key}"

exec /usr/local/bin/fly-mitm \
  --listen ":${MITM_PORT}" \
  --transform-url "${TRANSFORM_URL}" \
  --ca-cert "${MITM_CA_CERT}" \
  --ca-key "${MITM_CA_KEY}"
