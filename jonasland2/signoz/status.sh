#!/usr/bin/env bash
set -euo pipefail

curl -sS -o /dev/null -w "sig noz ui http status: %{http_code}\n" http://127.0.0.1:8080 || true
curl -sS -o /dev/null -w "otlp http status: %{http_code}\n" http://127.0.0.1:4318 || true

docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'signoz|NAMES' || true
