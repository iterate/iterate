#!/usr/bin/env bash
set -euo pipefail

SIGNOZ_DIR="${SIGNOZ_DIR:-$HOME/.cache/jonasland2/signoz}"

if [[ ! -d "${SIGNOZ_DIR}/deploy/docker" ]]; then
  echo "SigNoz deploy directory not found at ${SIGNOZ_DIR}/deploy/docker"
  exit 0
fi

pushd "${SIGNOZ_DIR}/deploy/docker" >/dev/null
docker compose -f docker-compose.yaml down
popd >/dev/null

echo "SigNoz stopped."
