#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: starts pidnap process manager which runs daemon, opencode, and egress proxy.
# ITERATE_REPO is set in Dockerfile.

# Signal readiness for tests and stuff
touch /tmp/.iterate-sandbox-ready

# Pidnap take the wheel
exec tini -sg -- pidnap init -c "$ITERATE_REPO/apps/os/sandbox/pidnap.config.ts"
