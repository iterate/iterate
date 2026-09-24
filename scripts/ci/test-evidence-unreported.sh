#!/usr/bin/env bash
# THE TEST EVIDENCE STEPS' FALLBACK REPORT (docs/test-evidence.md#what-ci-does). The write and
# upload steps are `continue-on-error`, and each reports its own failure (reportStepFailure in
# scripts/ci/test-evidence.ts): a warning annotation, a line of the job's summary, and a marker in
# the runner's temporary directory. A workflow runs this when either step's outcome is `failure`,
# and it reports the step that failed before it could say why: Doppler refusing, pnpm or tsx
# crashing, or the step's timeout. Plain shell, so it needs none of those.
#
#   bash scripts/ci/test-evidence-unreported.sh <write step outcome> <upload step outcome>
set -u

markers="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

report() {
  local command="$1" title="$2"
  if [ -e "$markers/test-evidence-$command.reported" ]; then return; fi
  local why="the $command step failed before it could say why (Doppler, pnpm or the step's timeout); its log has the rest"
  echo "::warning title=$title::$why"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "**$title**: $why. The tests' result is unaffected." >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ "${1:-}" = failure ]; then report write "No test evidence manifest"; fi
if [ "${2:-}" = failure ]; then report upload "Test evidence not in R2"; fi
exit 0
