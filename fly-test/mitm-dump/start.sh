#!/usr/bin/env bash
set -euo pipefail

MITM_PORT="${MITM_PORT:-18080}"
VIEWER_PORT="${VIEWER_PORT:-18081}"
FORWARD_PORT="${FORWARD_PORT:-18082}"
MITM_DIR="${MITM_DIR:-/data/mitm}"
MITM_CONF_DIR="${MITM_CONF_DIR:-${MITM_DIR}/mitmproxy}"
MITM_CA_CERT="${MITM_CA_CERT:-${MITM_DIR}/ca.crt}"
MITM_CA_KEY="${MITM_CA_KEY:-${MITM_DIR}/ca.key}"

mkdir -p "${MITM_CONF_DIR}"

if [ ! -f "${MITM_CA_CERT}" ] || [ ! -f "${MITM_CA_KEY}" ]; then
  echo "missing cert input: ${MITM_CA_CERT} and/or ${MITM_CA_KEY}" >&2
  exit 1
fi

cat "${MITM_CA_CERT}" "${MITM_CA_KEY}" > "${MITM_CONF_DIR}/mitmproxy-ca.pem"
cp "${MITM_CA_CERT}" "${MITM_CONF_DIR}/mitmproxy-ca-cert.pem"

exec mitmdump \
  --listen-host 0.0.0.0 \
  --listen-port "${MITM_PORT}" \
  --mode "reverse:http://127.0.0.1:${FORWARD_PORT}" \
  --set "confdir=${MITM_CONF_DIR}" \
  --set "keep_host_header=true" \
  --set "showhost=true" \
  --set "block_global=false"
