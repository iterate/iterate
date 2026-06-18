#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  doppler run --project _shared --config prd -- pnpm preview:ci <pr-number>

Runs the same preview lifecycle shape as CI for a pull request:
  1. pnpm preview deploy
  2. pnpm preview test

The script uses gh auth token when GITHUB_TOKEN is not already set.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

pr_number="${1:-${GITHUB_PR_NUMBER:-}}"
if [[ -z "$pr_number" ]]; then
  usage >&2
  exit 1
fi

if [[ -z "${DOPPLER_CONFIG:-}" && -z "${SEMAPHORE_API_TOKEN:-}" && -z "${APP_CONFIG_SHARED_API_SECRET:-}" ]]; then
  echo "Run this under Doppler, for example:" >&2
  echo "  doppler run --project _shared --config prd -- pnpm preview:ci $pr_number" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required to read pull request metadata." >&2
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  export GITHUB_TOKEN
  GITHUB_TOKEN="$(gh auth token)"
fi

if [[ -z "${WORKFLOW_RUN_URL:-}" ]]; then
  export WORKFLOW_RUN_URL
  WORKFLOW_RUN_URL="$(
    gh pr view "$pr_number" \
      --repo "${GITHUB_REPOSITORY:-iterate/iterate}" \
      --json url \
      --jq .url
  )"
fi

echo "[preview:ci] deploy PR #$pr_number"
pnpm preview deploy \
  --github-token "$GITHUB_TOKEN" \
  --pull-request-number "$pr_number"

echo "[preview:ci] test PR #$pr_number"
pnpm preview test \
  --github-token "$GITHUB_TOKEN" \
  --pull-request-number "$pr_number"
