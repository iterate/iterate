#!/bin/bash
set -euo pipefail

curl -sS -X POST http://127.0.0.1:3000/api/internal/refresh-env >/tmp/env-refresh.log 2>&1 || true
sleep 3600
