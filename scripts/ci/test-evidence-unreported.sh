#!/usr/bin/env bash
# THE TEST EVIDENCE STEPS' FALLBACK REPORT (docs/test-evidence.md#what-ci-does), for a write or
# upload that failed before its own report (reportStepFailure in scripts/ci/test-evidence.ts) could
# run: Node or Doppler failing, or the step's timeout. Plain shell, so it needs none of those. A
# workflow runs it when either step's outcome is `failure`, and it leaves alone a step whose marker
# says it reported.
#
# The write shares its step with the telemetry finalizer, which can fail it after the manifest is
# written (`finalize`), so a failed step is the write's only when it left no manifest.
#
#   bash scripts/ci/test-evidence-unreported.sh <write step outcome> <upload step outcome>
set -u

markers="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

report() {
  local command="$1" title="$2"
  if [ -e "$markers/test-evidence-$command.reported" ]; then return; fi
  local why="the $command step failed before it could say why (Node, Doppler or the step's timeout); its log has the rest"
  echo "::warning title=$title::$why"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "**$title**: $why. The tests' result is unaffected." >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ "${1:-}" = failure ] && [ ! -e test-results/manifest.json ]; then
  report write "No test evidence manifest"
fi
if [ "${2:-}" = failure ]; then report upload "Test evidence not in R2"; fi
exit 0
