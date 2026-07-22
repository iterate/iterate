#!/usr/bin/env bash
# Prove the real preview critical path repeatedly: deploy the full fleet, run
# every e2e lane, and fail on the first test failure, absorbed retry, or
# five-minute tail.
set -uo pipefail

PR_NUMBER="${PR_NUMBER:?PR_NUMBER is required}"
RUNS="${RUNS:-25}"
MAX_RUN_DURATION_SECS="${MAX_RUN_DURATION_SECS:-300}"
RUN_TIMEOUT_SECS="${RUN_TIMEOUT_SECS:-600}"
MAX_SLOT_RECLAIMS="${MAX_SLOT_RECLAIMS:-2}"
LOG_DIR="${LOG_DIR:-/tmp/flake-hunt}"
SUMMARY_FILE="$LOG_DIR/summary.tsv"

require_positive_integer() {
  local name=$1 value=$2
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer, got: $value" >&2
    exit 64
  fi
}

require_positive_integer PR_NUMBER "$PR_NUMBER"
require_positive_integer RUNS "$RUNS"
require_positive_integer MAX_RUN_DURATION_SECS "$MAX_RUN_DURATION_SECS"
require_positive_integer RUN_TIMEOUT_SECS "$RUN_TIMEOUT_SECS"
require_positive_integer MAX_SLOT_RECLAIMS "$MAX_SLOT_RECLAIMS"

# Match the normal preview workflow: one retry belongs to each test framework,
# never to an app lane or a whole preview run.
export CI=true

mkdir -p "$LOG_DIR"
printf 'run\tattempt\tstatus\tduration_seconds\tretries\tstarted_at\tfinished_at\tdeploy_log\ttest_log\n' >"$SUMMARY_FILE"

kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -KILL "$pid" 2>/dev/null
}

run_with_watchdog() {
  local timeout_seconds=$1 log=$2
  shift 2

  "$@" >"$log" 2>&1 &
  local command_pid=$!
  (
    sleep "$timeout_seconds"
    echo "WATCHDOG: killing command tree after ${timeout_seconds}s" >>"$log"
    kill_tree "$command_pid"
  ) &
  local watchdog_pid=$!

  wait "$command_pid"
  local exit_code=$?
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null
  return "$exit_code"
}

retry_count() {
  local log=$1 annotations onboarding
  annotations=$(
    sed -nE 's/.*title=Preview e2e retries::.*: ([0-9]+) retried:.*/\1/p' "$log" |
      awk '{ total += $1 } END { print total + 0 }'
  )
  onboarding=$(grep -cF '[retry-telemetry] onboarding smoke passed on attempt 2/2' "$log")
  echo $((annotations + onboarding))
}

record_result() {
  local run=$1 attempt=$2 status=$3 duration=$4 retries=$5 started=$6 finished=$7 deploy_log=$8 test_log=$9
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run" "$attempt" "$status" "$duration" "$retries" "$started" "$finished" "$deploy_log" "$test_log" >>"$SUMMARY_FILE"
}

slot_reclaims=0
run=1
attempt=1

while [ "$run" -le "$RUNS" ]; do
  run_label=$(printf '%03d' "$run")
  attempt_label=$(printf '%02d' "$attempt")
  deploy_log="$LOG_DIR/run-$run_label-attempt-$attempt_label-deploy.log"
  test_log="$LOG_DIR/run-$run_label-attempt-$attempt_label-test.log"
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  started_epoch=$(date +%s)

  echo "run $run/$RUNS: deploying the full fleet (attempt $attempt)"
  run_with_watchdog "$RUN_TIMEOUT_SECS" "$deploy_log" \
    doppler run --project _shared --config prd -- pnpm preview deploy --all-apps --allow-draft \
    --pull-request-number "$PR_NUMBER"
  deploy_exit=$?

  if [ "$deploy_exit" -ne 0 ] || grep -qE 'deploy-failed|claim-failed' "$deploy_log"; then
    finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    duration=$(( $(date +%s) - started_epoch ))
    status=DEPLOY_FAIL
    if grep -q '^WATCHDOG:' "$deploy_log"; then status=WATCHDOG; fi
    record_result "$run" "$attempt" "$status" "$duration" 0 "$started_at" "$finished_at" "$deploy_log" "-"
    echo "run $run: $status exit=$deploy_exit (${duration}s) — $deploy_log"
    exit 1
  fi

  elapsed=$(( $(date +%s) - started_epoch ))
  remaining=$((RUN_TIMEOUT_SECS - elapsed))
  if [ "$remaining" -le 0 ]; then
    finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    record_result "$run" "$attempt" WATCHDOG "$elapsed" 0 "$started_at" "$finished_at" "$deploy_log" "-"
    echo "run $run: WATCHDOG after deploy (${elapsed}s) — $deploy_log"
    exit 1
  fi

  echo "run $run/$RUNS: running every e2e lane in parallel (${remaining}s watchdog remaining)"
  run_with_watchdog "$remaining" "$test_log" \
    doppler run --project _shared --config prd -- pnpm preview test \
    --pull-request-number "$PR_NUMBER"
  test_exit=$?

  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  duration=$(( $(date +%s) - started_epoch ))
  retries=$(retry_count "$test_log")

  # The ownership guard fires before tests when another PR claims this slot.
  # No test attempt occurred, so restoring the environment is not a retry.
  if grep -q 'no longer belongs to' "$test_log"; then
    record_result "$run" "$attempt" SLOT_STOLEN "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    slot_reclaims=$((slot_reclaims + 1))
    if [ "$slot_reclaims" -gt "$MAX_SLOT_RECLAIMS" ]; then
      echo "run $run: FAIL — slot re-claim budget exhausted (${duration}s)"
      exit 1
    fi
    echo "run $run: slot claimed externally; re-running uncounted (${duration}s)"
    attempt=$((attempt + 1))
    continue
  fi

  if grep -q 'skipped: true' "$test_log"; then
    record_result "$run" "$attempt" SKIPPED "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    echo "run $run: SKIPPED — no tests ran (${duration}s)"
    exit 2
  fi

  testable_line=$(grep -m1 'testable apps:' "$test_log" || true)
  missing=""
  for app in os semaphore auth streams-example-app dummy-petshop; do
    case "$testable_line" in
      *"$app"*) ;;
      *) missing="$missing $app" ;;
    esac
  done
  if [ -z "$testable_line" ] || [ -n "$missing" ]; then
    record_result "$run" "$attempt" PARTIAL "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    echo "run $run: PARTIAL — missing:${missing:- unknown} (${duration}s)"
    exit 3
  fi

  if [ "$test_exit" -ne 0 ]; then
    status=TEST_FAIL
    if grep -q '^WATCHDOG:' "$test_log"; then status=WATCHDOG; fi
    record_result "$run" "$attempt" "$status" "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    echo "run $run: $status exit=$test_exit (${duration}s, retries=$retries) — $test_log"
    exit 1
  fi

  # A retry remains green in ordinary PR CI so an unrelated intermittent test
  # does not block delivery. This loop is stricter: its purpose is to prove a
  # genuinely clean streak, so a passed retry is evidence to diagnose rather
  # than an accepted run.
  if [ "$retries" -gt 0 ]; then
    record_result "$run" "$attempt" RETRIED "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    echo "run $run: RETRIED (${duration}s, retries=$retries); streak rejected — $test_log"
    exit 6
  fi

  if [ "$duration" -ge "$MAX_RUN_DURATION_SECS" ]; then
    record_result "$run" "$attempt" SLOW "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
    echo "run $run: SLOW (${duration}s, budget <${MAX_RUN_DURATION_SECS}s, retries=$retries)"
    exit 5
  fi

  record_result "$run" "$attempt" PASS "$duration" "$retries" "$started_at" "$finished_at" "$deploy_log" "$test_log"
  echo "run $run: PASS (${duration}s, retries=$retries)"
  run=$((run + 1))
  attempt=1
done

echo "all $RUNS full preview runs passed without retries and each completed in <${MAX_RUN_DURATION_SECS}s"
