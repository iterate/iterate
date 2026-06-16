#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  doppler run --project _shared --config prd -- pnpm preview:ci <pr-number>

Runs the same preview lifecycle shape as CI for a pull request:
  1. pnpm preview deploy
  2. pnpm preview test

The script reads PR head/base metadata through gh and uses gh auth token when
GITHUB_TOKEN is not already set.
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

repository_full_name="${GITHUB_REPOSITORY:-iterate/iterate}"

eval "$(
  gh pr view "$pr_number" \
    --repo "$repository_full_name" \
    --json headRefName,headRefOid,baseRefOid,isCrossRepository,url \
    --jq '"PR_HEAD_REF_NAME=\(.headRefName|@sh)
PR_HEAD_SHA=\(.headRefOid|@sh)
PR_BASE_SHA=\(.baseRefOid|@sh)
PR_IS_FORK=\(.isCrossRepository)
PR_URL=\(.url|@sh)"'
)"

workflow_run_url="${WORKFLOW_RUN_URL:-$PR_URL}"

common_args=(
  --github-token "$GITHUB_TOKEN"
  --pull-request-number "$pr_number"
  --repository-full-name "$repository_full_name"
  --workflow-run-url "$workflow_run_url"
)

echo "[preview:ci] deploy PR #$pr_number ($PR_HEAD_SHA)"
pnpm preview deploy \
  "${common_args[@]}" \
  --pull-request-head-ref-name "$PR_HEAD_REF_NAME" \
  --pull-request-head-sha "$PR_HEAD_SHA" \
  --pull-request-base-sha "$PR_BASE_SHA" \
  --is-fork "$PR_IS_FORK"

echo "[preview:ci] test PR #$pr_number ($PR_HEAD_SHA)"
pnpm preview test \
  "${common_args[@]}" \
  --pull-request-head-sha "$PR_HEAD_SHA"
