#!/usr/bin/env bash
# Dispatch the canonical Depot preview workflow repeatedly. Every iteration is
# a normal Cloudflare Preview run: fresh Depot runner, clean preview-slot data,
# full-fleet deploy, all e2e lanes, artifacts, GitHub check timings, and
# PostHog telemetry.
set -euo pipefail

PR_NUMBER="${PR_NUMBER:?PR_NUMBER is required}"
RUNS="${RUNS:-25}"
MAX_RUN_DURATION_SECS="${MAX_RUN_DURATION_SECS:-420}"
RUN_TIMEOUT_SECS="${RUN_TIMEOUT_SECS:-600}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-5}"
DEPOT_ORG="${DEPOT_ORG:-0p91s0lz49}"
DEPOT_REPO="${DEPOT_REPO:-iterate/iterate}"
REF="${REF:-$(git branch --show-current)}"

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
require_positive_integer POLL_INTERVAL_SECS "$POLL_INTERVAL_SECS"

if [ -z "$REF" ]; then
  echo "REF is required when the current checkout is detached" >&2
  exit 64
fi

command -v depot >/dev/null || { echo "depot CLI is required" >&2; exit 69; }
command -v node >/dev/null || { echo "node is required" >&2; exit 69; }
command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 69; }

if [ -z "${LOG_DIR:-}" ]; then
  LOG_DIR=$(mktemp -d /tmp/preview-e2e-marathon.XXXXXX)
fi
mkdir -p "$LOG_DIR"
SUMMARY_FILE="$LOG_DIR/summary.tsv"
printf 'run\tstatus\tduration_seconds\tretries\thead_sha\trun_id\tattempt_id\tcreated_at\tstarted_at\tfinished_at\tlog\tmetadata\n' >"$SUMMARY_FILE"

json_run_id() {
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")).run_id; if (!value) process.exit(1); process.stdout.write(value)' "$1"
}

json_status() {
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")).status; if (!value) process.exit(1); process.stdout.write(value)' "$1"
}

json_attempt_id() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const workflow = status.workflows?.find((item) => item.workflow_path === "cloudflare-previews.yml");
    const job = workflow?.jobs?.find((item) => item.job_key === "cloudflare-previews.yml:preview");
    const attempt = job?.attempts?.at(-1);
    if (!attempt?.attempt_id) process.exit(1);
    process.stdout.write(attempt.attempt_id);
  ' "$1"
}

json_run_field() {
  node -e '
    const fs = require("node:fs");
    const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = run[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2"
}

json_artifact_id() {
  node -e '
    const fs = require("node:fs");
    const artifacts = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).artifacts ?? [];
    const artifact = artifacts.find(
      (item) =>
        item.attempt_id === process.argv[2] && item.name === "preview-os-test-artifacts",
    );
    if (!artifact?.artifact_id) process.exit(1);
    process.stdout.write(artifact.artifact_id);
  ' "$1" "$2"
}

artifact_retry_count() {
  local artifact=$1 entry count total=0
  # Failed preview commands can skip preview.ts's GitHub retry annotation, but
  # the always-run finalizer still packages every runner's canonical telemetry.
  # Sum the raw, non-aggregated test records so a terminal workflow cannot look
  # retry-free merely because its failing lane's buffered log was never replayed.
  while IFS= read -r entry; do
    count=$(
      unzip -p "$artifact" "$entry" |
        node -e '
          let json = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => (json += chunk));
          process.stdin.on("end", () => {
            const artifact = JSON.parse(json);
            const retries = (artifact.tests ?? []).reduce(
              (total, test) => total + (Number.isInteger(test.retryCount) ? test.retryCount : 0),
              0,
            );
            process.stdout.write(String(retries));
          });
        '
    )
    total=$((total + count))
  done < <(unzip -Z1 "$artifact" | grep -E '^ci-telemetry/raw/[^/]+[.]json$')
  echo "$total"
}

retry_count() {
  local log=$1 artifact=${2:-} annotations onboarding runner transport
  # Depot's finite log export renders GitHub workflow commands as
  # `##[notice]`/`##[warning]`. Keep the raw command fallback for older CLI
  # exports, but never sum both representations of the same annotations.
  annotations=$(
    sed -nE 's/.*##\[(notice|warning)\][^:]+: ([0-9]+) retried:.*/\2/p' "$log" |
      awk '{ total += $1 } END { print total + 0 }'
  )
  if [ "$annotations" -eq 0 ]; then
    annotations=$(
      sed -nE 's/.*title=Preview e2e retries::.*: ([0-9]+) retried:.*/\1/p' "$log" |
        awk '{ total += $1 } END { print total + 0 }'
    )
  fi
  onboarding=$(grep -cF '[retry-telemetry] onboarding smoke passed on attempt 2/2' "$log" || true)
  # A fresh pre-session WebSocket dial keeps ordinary CI reliable without
  # replaying any RPC work, but the strict proof still rejects the recovery.
  # The same marker is emitted by the CLI and Playwright admin helpers.
  transport=$(grep -cF '[itx-initial-connection-retry] ' "$log" || true)
  if [ -n "$artifact" ]; then
    runner=$(artifact_retry_count "$artifact")
    # A successful run also announces these same runner retries. Use the
    # larger observation, never their sum, to avoid counting each test twice.
    if [ "$annotations" -gt "$runner" ]; then runner=$annotations; fi
  else
    # Last-resort fallback for a run that failed before its required artifact
    # was finalized.
    runner=$((annotations + onboarding))
  fi
  echo $((runner + transport))
}

record_result() {
  local run=$1 status=$2 duration=$3 retries=$4 head_sha=$5 run_id=$6 attempt_id=$7 created=$8 started=$9 finished=${10} log=${11} metadata=${12}
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run" "$status" "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created" "$started" "$finished" "$log" "$metadata" >>"$SUMMARY_FILE"
}

expected_head_sha="${EXPECTED_HEAD_SHA:-}"
for run in $(seq 1 "$RUNS"); do
  run_label=$(printf '%03d' "$run")
  dispatch_file="$LOG_DIR/run-$run_label-dispatch.json"
  status_file="$LOG_DIR/run-$run_label-status.json"
  metadata_file="$LOG_DIR/run-$run_label-metadata.json"
  log_file="$LOG_DIR/run-$run_label.log"
  artifact_metadata_file="$LOG_DIR/run-$run_label-artifacts.json"
  artifact_file="$LOG_DIR/run-$run_label-artifacts.zip"
  observed_started_epoch=$(date +%s)

  echo "run $run/$RUNS: dispatching canonical cloudflare-previews.yml at $REF"
  if ! depot ci dispatch \
    --org "$DEPOT_ORG" \
    --repo "$DEPOT_REPO" \
    --workflow cloudflare-previews.yml \
    --ref "$REF" \
    --input "pull-request-number=$PR_NUMBER" \
    --input "fresh_data=true" \
    --output json >"$dispatch_file"; then
    record_result "$run" DISPATCH_FAIL 0 0 - - - - - - - "$dispatch_file"
    echo "run $run: DISPATCH_FAIL — $dispatch_file" >&2
    exit 1
  fi
  run_id=$(json_run_id "$dispatch_file")
  echo "run $run/$RUNS: Depot run $run_id"

  while true; do
    depot ci status "$run_id" --org "$DEPOT_ORG" --output json >"$status_file"
    status=$(json_status "$status_file")
    case "$status" in
      pending|queued|running)
        elapsed=$(( $(date +%s) - observed_started_epoch ))
        if [ "$elapsed" -ge "$RUN_TIMEOUT_SECS" ]; then
          depot ci cancel "$run_id" --org "$DEPOT_ORG" >/dev/null 2>&1 || true
          record_result "$run" WATCHDOG "$elapsed" 0 - "$run_id" - - - - - "$status_file"
          echo "run $run: WATCHDOG after ${elapsed}s — Depot run $run_id cancelled" >&2
          exit 1
        fi
        sleep "$POLL_INTERVAL_SECS"
        ;;
      *) break ;;
    esac
  done

  attempt_id=$(json_attempt_id "$status_file" || true)
  if [ -z "$attempt_id" ]; then
    record_result "$run" OBSERVATION_FAIL 0 0 - "$run_id" - - - - - "$status_file"
    echo "run $run: OBSERVATION_FAIL — canonical preview attempt missing from Depot run $run_id" >&2
    exit 1
  fi

  depot ci logs "$attempt_id" --org "$DEPOT_ORG" --output-file "$log_file"
  depot ci run show "$run_id" --org "$DEPOT_ORG" --output json >"$metadata_file"
  created_at=$(json_run_field "$metadata_file" created_at)
  started_at=$(json_run_field "$metadata_file" started_at)
  finished_at=$(json_run_field "$metadata_file" finished_at)
  head_sha=$(json_run_field "$metadata_file" head_sha)
  duration=$(
    node -e 'const [start,end]=process.argv.slice(1).map(Date.parse); process.stdout.write(String(Math.ceil((end-start)/1000)))' "$created_at" "$finished_at"
  )
  artifact_id=""
  depot ci artifacts list "$run_id" --org "$DEPOT_ORG" --output json >"$artifact_metadata_file"
  artifact_id=$(json_artifact_id "$artifact_metadata_file" "$attempt_id" || true)
  if [ -n "$artifact_id" ]; then
    depot ci artifacts download "$artifact_id" \
      --org "$DEPOT_ORG" \
      --output-file "$artifact_file"
  fi
  artifact_retry_file=""
  if [ -f "$artifact_file" ]; then artifact_retry_file=$artifact_file; fi
  retries=$(retry_count "$log_file" "$artifact_retry_file")

  if [ -z "$expected_head_sha" ]; then
    expected_head_sha="$head_sha"
  elif [ "$head_sha" != "$expected_head_sha" ]; then
    record_result "$run" HEAD_MOVED "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$metadata_file"
    echo "run $run: HEAD_MOVED ($head_sha, expected $expected_head_sha); streak rejected — Depot run $run_id" >&2
    exit 4
  fi

  if [ "$status" != finished ]; then
    record_result "$run" WORKFLOW_FAIL "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$metadata_file"
    echo "run $run: WORKFLOW_FAIL (${duration}s, retries=$retries) — Depot run $run_id; $log_file" >&2
    exit 1
  fi

  if [ ! -f "$artifact_file" ]; then
    record_result "$run" OBSERVATION_FAIL "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$artifact_metadata_file"
    echo "run $run: OBSERVATION_FAIL — required preview telemetry artifact missing from Depot run $run_id" >&2
    exit 1
  fi

  if [ "$retries" -gt 0 ]; then
    record_result "$run" RETRIED "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$metadata_file"
    echo "run $run: RETRIED (${duration}s, retries=$retries); streak rejected — Depot run $run_id; $log_file" >&2
    exit 6
  fi

  if [ "$duration" -ge "$MAX_RUN_DURATION_SECS" ]; then
    record_result "$run" SLOW "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$metadata_file"
    echo "run $run: SLOW (${duration}s, budget <${MAX_RUN_DURATION_SECS}s) — Depot run $run_id" >&2
    exit 5
  fi

  record_result "$run" PASS "$duration" "$retries" "$head_sha" "$run_id" "$attempt_id" "$created_at" "$started_at" "$finished_at" "$log_file" "$metadata_file"
  echo "run $run: PASS (${duration}s, retries=0) — Depot run $run_id"
done

echo "all $RUNS canonical preview workflows passed without retries and each completed in <${MAX_RUN_DURATION_SECS}s"
echo "ledger: $SUMMARY_FILE"
