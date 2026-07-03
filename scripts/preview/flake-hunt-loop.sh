#!/usr/bin/env bash
# Repeatedly run the preview e2e lane against this PR's deployed slot and stop
# on the first failure. Used by the flake hunt (docs/preview-e2e-flake-hunt.md)
# to count consecutive green runs; each run's full output lands in
# $LOG_DIR/run-<n>.log so a failure can be diagnosed after the fact.
set -uo pipefail

PR_NUMBER="${PR_NUMBER:-1644}"
RUNS="${RUNS:-5}"
LOG_DIR="${LOG_DIR:-/tmp/flake-hunt}"
START_AT="${START_AT:-1}"

mkdir -p "$LOG_DIR"
for i in $(seq "$START_AT" $((START_AT + RUNS - 1))); do
  log="$LOG_DIR/run-$(printf '%03d' "$i").log"
  started=$(date -u +%H:%M:%S)
  doppler run --project _shared --config prd -- pnpm preview test \
    --pull-request-number "$PR_NUMBER" >"$log" 2>&1
  exit_code=$?
  finished=$(date -u +%H:%M:%S)
  # `preview test` exits 0 but skips (stale head, no lease) without running
  # anything — a skip must not count as a green run.
  if grep -q "skipped: true" "$log"; then
    echo "run $i: SKIPPED — not a real run ($started-$finished UTC) $log"
    exit 2
  fi
  if [ "$exit_code" -eq 0 ]; then
    echo "run $i: PASS ($started-$finished UTC) $log"
  else
    echo "run $i: FAIL exit=$exit_code ($started-$finished UTC) $log"
    exit 1
  fi
done
echo "all $RUNS runs green"
