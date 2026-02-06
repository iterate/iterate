#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_PATH="$ROOT_DIR/egress-proxy/go-mitm/fly-mitm-linux-amd64"

docker run --rm --platform linux/amd64 \
  -v "$ROOT_DIR:/repo/fly-test" \
  -w /repo/fly-test/egress-proxy/go-mitm \
  golang:1.25-bookworm \
  bash -lc 'go mod download && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /repo/fly-test/egress-proxy/go-mitm/fly-mitm-linux-amd64 ./'

chmod +x "$OUT_PATH"
ls -lh "$OUT_PATH"
