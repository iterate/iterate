#!/usr/bin/env bash
# THE TEST EVIDENCE STEPS' FALLBACK REPORT (docs/test-evidence.md#what-ci-does). The manifest's write
# and the upload each report their own failure (reportStepFailure in scripts/ci/test-evidence.ts): a
# warning annotation, a line of the job's summary, and a marker in the runner's temporary directory.
# A workflow runs this when either step's outcome is `failure`, and it reports the one that failed
# before it could say why: Node or Doppler crashing or refusing, or the step's timeout. Plain shell,
# so it needs none of those.
#
# The write shares its step with the telemetry finalizer (`test-evidence.ts finalize`), which fails
# the step on incomplete telemetry after the manifest is written; so a failed step is the write's
# only when it left no manifest.
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
