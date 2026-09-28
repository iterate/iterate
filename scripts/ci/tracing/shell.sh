# BASH_ENV: sourced before each run step, including pnpm install. Plain bash, no process started:
# every traced step pays for the hook twice, and a step inside a parallel block pays for it while
# the block's other steps start beside it. Child shells inherit the guard; their lifetime is
# already in the enclosing step.
if [ -z "${CI_TRACE_SHELL:-}" ]; then
  export CI_TRACE_SHELL="$$"
  # Milliseconds since the epoch into $ci_trace_ms: bash 5's EPOCHREALTIME (microseconds, its
  # decimal separator the locale's, so only its digits are kept), else date's.
  ci_trace_time() {
    ci_trace_ms="${EPOCHREALTIME//[!0-9]/}"
    if [ -n "$ci_trace_ms" ]; then ci_trace_ms=$((ci_trace_ms / 1000)); else ci_trace_ms=$(date +%s%3N); fi
  }
  ci_trace_step="${GITHUB_ACTION:-shell}"
  ci_trace_step="${ci_trace_step//\\/\\\\}"
  ci_trace_step="${ci_trace_step//\"/\\\"}"
  ci_trace_time
  printf '@@ci-trace {"kind":"shell-start","id":"%s","step":"%s","time":%s}\n' \
    "$CI_TRACE_SHELL" "$ci_trace_step" "$ci_trace_ms"
  ci_trace_exit() {
    local status="$1" event
    ci_trace_time
    printf -v event '{"kind":"shell-end","id":"%s","time":%s,"exitCode":%s}' \
      "$CI_TRACE_SHELL" "$ci_trace_ms" "$status"
    echo "@@ci-trace $event"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "ci-trace-end=$event" >>"$GITHUB_OUTPUT"; fi
    exit "$status"
  }
  trap 'ci_trace_exit "$?"' EXIT
fi
