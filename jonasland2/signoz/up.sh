#!/usr/bin/env bash
set -euo pipefail

SIGNOZ_DIR="${SIGNOZ_DIR:-$HOME/.cache/jonasland2/signoz}"
SIGNOZ_REPO="${SIGNOZ_REPO:-https://github.com/SigNoz/signoz.git}"
SIGNOZ_REF="${SIGNOZ_REF:-main}"

if [[ ! -d "${SIGNOZ_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${SIGNOZ_DIR}")"
  git clone --depth 1 --branch "${SIGNOZ_REF}" "${SIGNOZ_REPO}" "${SIGNOZ_DIR}"
else
  git -C "${SIGNOZ_DIR}" fetch origin "${SIGNOZ_REF}" --depth 1
  git -C "${SIGNOZ_DIR}" checkout "${SIGNOZ_REF}"
  git -C "${SIGNOZ_DIR}" reset --hard "origin/${SIGNOZ_REF}"
fi

pushd "${SIGNOZ_DIR}/deploy/docker" >/dev/null
docker compose -f docker-compose.yaml up -d
popd >/dev/null

echo "SigNoz is starting."
echo "UI: http://127.0.0.1:8080"
echo "OTLP gRPC: 127.0.0.1:4317"
echo "OTLP HTTP: 127.0.0.1:4318"
