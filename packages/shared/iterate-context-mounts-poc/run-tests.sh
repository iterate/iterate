#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm exec vitest run --config ./iterate-context-mounts-poc.vitest.config.ts
