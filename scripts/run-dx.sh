#!/usr/bin/env bash
#
# Run the full DX check pipeline.
#
# Usage:
#   ./scripts/run-dx.sh           # run all phases
#   ./scripts/run-dx.sh setup     # run a specific phase
#   ./scripts/run-dx.sh os-hmr    # run a specific phase
#
# Prerequisites:
#   - pnpm docker:up
#   - pnpm dev (running in another terminal)
#   - Clean git working tree
#
set -euo pipefail

cd "$(dirname "$0")/.."

COMMAND="${1:-all}"

exec tsx scripts/dx.ts "$COMMAND"
