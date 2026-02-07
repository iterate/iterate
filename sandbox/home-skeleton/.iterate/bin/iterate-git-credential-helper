#!/bin/bash
# Git credential helper for iterate sandboxes.
# Supports two modes:
#   1. Proxy mode (default): returns magic string, egress proxy resolves to real token
#   2. Raw secrets mode (DANGEROUS_RAW_SECRETS_ENABLED): uses GITHUB_ACCESS_TOKEN env var directly

# If GITHUB_ACCESS_TOKEN isn't in the environment, try to extract it from the
# daemon-managed .env file. We use grep+sed instead of bash-sourcing because the
# file is dotenv format — values may contain $ or backticks that bash would expand.
if [ -z "$GITHUB_ACCESS_TOKEN" ] && [ -f ~/.iterate/.env ]; then
  GITHUB_ACCESS_TOKEN=$(grep -m1 '^GITHUB_ACCESS_TOKEN=' ~/.iterate/.env | sed 's/^GITHUB_ACCESS_TOKEN=//; s/^"//; s/"$//')
fi

echo "username=x-access-token"
if [ -n "$GITHUB_ACCESS_TOKEN" ]; then
  # Raw secrets mode — token is available as env var, no proxy needed
  echo "password=$GITHUB_ACCESS_TOKEN"
else
  # Proxy mode — egress proxy will replace magic string with real token
  echo "password=getIterateSecret({secretKey: 'github.access_token'})"
fi
