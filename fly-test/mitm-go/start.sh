#!/usr/bin/env bash
set -euo pipefail

MITM_PORT="${MITM_PORT:-18080}"
HANDLER_URL="${HANDLER_URL:-http://127.0.0.1:18081/proxy}"
PROXIFY_CONFIG_DIR="${PROXIFY_CONFIG_DIR:-/data/proxify}"

mkdir -p "$PROXIFY_CONFIG_DIR"

exec env \
  MITM_PORT="${MITM_PORT}" \
  HANDLER_URL="${HANDLER_URL}" \
  PROXIFY_CONFIG_DIR="${PROXIFY_CONFIG_DIR}" \
  /usr/local/bin/fly-mitm
