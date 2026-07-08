#!/usr/bin/env bash
# Repeatedly run the preview e2e lane against this PR's deployed slot and stop
# on the first failure. Used by the flake hunt (docs/preview-e2e-flake-hunt.md)
# to count consecutive green runs; each run's full output lands in
# $LOG_DIR/run-<n>.log so a failure can be diagnosed after the fact.
set -uo pipefail

PR_NUMBER="${PR_NUMBER:-1664}"
RUNS="${RUNS:-5}"
LOG_DIR="${LOG_DIR:-/tmp/flake-hunt}"
START_AT="${START_AT:-1}"

# macOS idle-sleeps ~15 minutes into an unattended loop; a sleeping laptop
# freezes tests mid-flight (14-16 minute "hangs", dropped WebSockets) that
# look exactly like server-side flakes. Re-exec under caffeinate so the
# machine stays awake for the duration of the loop.
if [ "$(uname)" = "Darwin" ] && [ -z "${FLAKE_HUNT_CAFFEINATED:-}" ]; then
  export FLAKE_HUNT_CAFFEINATED=1
  # -d display, -i idle system, -m disk, -s system-on-AC. A bare `-is` still let
  # the machine sleep overnight once (r3d: a 5.5h gap de-provisioned the sandbox
  # container image). caffeinate can't beat a battery+lid-closed sleep, so also
  # keep the marathon continuous; this is best-effort on AC power.
  exec caffeinate -dims "$0" "$@"
fi

# Match the Depot CI contract exactly: the vitest e2e lane sets its retry
# policy and scheduling off CI=true (one retry absorbs platform blips like
# Cloudflare's retryable "internal error; reference = ..." resets; retried
# tests are still visible in the run log). Without this the local loop runs a
# STRICTER config than the pipeline it is trying to de-flake.
export CI=true

mkdir -p "$LOG_DIR"
# Watchdog for one whole run — it fails, it never retries, per the policy
# (docs/testing.md#retries-and-timeouts). Sized to ~2x a healthy full-fleet
# run (a few minutes), deliberately NOT to the worst-case retry stack: it MAY
# kill a run legitimately burning per-test retries against a wedged platform,
# and that is correct — both historical watchdog kills were genuine infra
# wedges where retrying was hopeless (an earlier bug let a startup wedge hang
# 9+ hours). The default must equal PREVIEW_RUN_WATCHDOG_SECS in
# packages/shared/src/test-support/e2e-policy/budgets.ts; shell can't import
# the constant, so scripts/preview/e2e-policy.test.ts guards the match.
RUN_TIMEOUT_SECS="${RUN_TIMEOUT_SECS:-600}"

# Full-fleet preflight. `preview deploy` selects apps by diffing the PR head
# against the LAST DEPLOYED head (not the PR base), so a mid-branch commit that
# touches only one app (e.g. an apps/os-only fix) redeploys just that app and
# leaves the others at an older head. The test lane only tests apps whose
# recorded head == the PR head, so the marathon then silently shrinks to the
# changed apps and every run trips the full-fleet guard (exit 3) — or worse,
# would count a partial lane as green if that guard were absent. `--all-apps`
# forces the full fleet regardless of the diff, which reunifies the head.
# So before a fresh marathon (START_AT=1) we run one deploy and assert all four
# apps come back testable at the current head; set SKIP_PREFLIGHT_DEPLOY=1 to
# bypass (e.g. resuming a marathon whose fleet is already unified).
if [ "$START_AT" -eq 1 ] && [ -z "${SKIP_PREFLIGHT_DEPLOY:-}" ]; then
  preflight="$LOG_DIR/preflight-deploy.log"
  echo "preflight: deploying full fleet for PR $PR_NUMBER (log: $preflight)"
  # --allow-draft: the marathon targets an arbitrary PR by number — an
  # explicit ask, so the draft preview policy doesn't apply.
  doppler run --project _shared --config prd -- pnpm preview deploy --all-apps --allow-draft \
    --pull-request-number "$PR_NUMBER" >"$preflight" 2>&1
  deploy_exit=$?
  if [ "$deploy_exit" -ne 0 ]; then
    echo "preflight: deploy FAILED (exit $deploy_exit) — see $preflight"
    exit 4
  fi
  if grep -qE "deploy-failed|claim-failed" "$preflight"; then
    echo "preflight: an app failed to deploy — see $preflight"
    exit 4
  fi
  echo "preflight: deploy OK"
fi

# Optional slot warmup: a freshly-deployed slot is cold (os worker + DO chain +
# sandbox containers all boot on first use), and a cold run 1 can flake on
# timing that a warm slot never would — which would reset the streak at run 1.
# WARMUP_RUNS uncounted `preview test` invocations warm the slot first; their
# pass/fail is ignored on purpose (they exist only to prime caches/containers).
WARMUP_RUNS="${WARMUP_RUNS:-0}"
for w in $(seq 1 "$WARMUP_RUNS"); do
  [ "$WARMUP_RUNS" -eq 0 ] && break
  wlog="$LOG_DIR/warmup-$(printf '%02d' "$w").log"
  echo "warmup $w/$WARMUP_RUNS: priming the slot (result ignored) -> $wlog"
  doppler run --project _shared --config prd -- pnpm preview test \
    --pull-request-number "$PR_NUMBER" >"$wlog" 2>&1 || true
done

for i in $(seq "$START_AT" $((START_AT + RUNS - 1))); do
  log="$LOG_DIR/run-$(printf '%03d' "$i").log"
  started=$(date -u +%H:%M:%S)
  doppler run --project _shared --config prd -- pnpm preview test \
    --pull-request-number "$PR_NUMBER" >"$log" 2>&1 &
  run_pid=$!
  (
    sleep "$RUN_TIMEOUT_SECS"
    echo "run $i: WATCHDOG — killing after ${RUN_TIMEOUT_SECS}s" >>"$log"
    # The run tree is deep (doppler -> pnpm -> trpc-cli -> inner doppler -> bash
    # -> vitest/playwright) and SIGTERM to the top does NOT propagate down — a
    # vitest-startup wedge survived a TERM and hung 58 min past this timeout
    # once. Walk the whole descendant tree and SIGKILL it leaf-first so nothing
    # is left holding the loop's `wait`.
    kill_tree() {
      local p=$1 c
      for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
      kill -KILL "$p" 2>/dev/null
    }
    kill_tree "$run_pid"
  ) &
  watchdog_pid=$!
  wait "$run_pid"
  exit_code=$?
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null
  finished=$(date -u +%H:%M:%S)
  # `preview test` exits 0 but skips (stale head, no lease) without running
  # anything — a skip must not count as a green run.
  if grep -q "skipped: true" "$log"; then
    echo "run $i: SKIPPED — not a real run ($started-$finished UTC) $log"
    exit 2
  fi
  # A push touching one app leaves the others' recorded states at an older
  # head, silently shrinking the lane (observed: three 13-second "green" runs
  # that tested only semaphore). The marathon must exercise the full fleet.
  # Checked per app, NOT as one literal line: the preview tool's print order
  # is not part of its contract (an order change once failed a genuinely
  # full-fleet green run as PARTIAL).
  testable_line=$(grep -m1 "testable apps:" "$log" || true)
  missing=""
  for app in os semaphore auth streams-example-app; do
    case "$testable_line" in *"$app"*) ;; *) missing="$missing $app" ;; esac
  done
  if [ -z "$testable_line" ] || [ -n "$missing" ]; then
    echo "run $i: PARTIAL — not all apps testable (missing:${missing:- unknown}) ($started-$finished UTC) $log"
    exit 3
  fi
  if [ "$exit_code" -eq 0 ]; then
    echo "run $i: PASS ($started-$finished UTC) $log"
  else
    echo "run $i: FAIL exit=$exit_code ($started-$finished UTC) $log"
    exit 1
  fi
done
echo "all $RUNS runs green"
