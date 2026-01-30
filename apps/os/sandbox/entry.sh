#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: starts pidnap process manager which runs daemon, opencode, and egress proxy.
# ITERATE_REPO is set in Dockerfile.
# Readiness is detected via pidnap's services.waitHealthy API (port 9876).

# Pidnap take the wheel (tsx --watch for hot-reload during development)
exec tini -sg -- tsx --watch "$ITERATE_REPO/packages/pidnap/src/cli.ts" init -c "$ITERATE_REPO/apps/os/sandbox/pidnap.config.ts"
