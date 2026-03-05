#!/bin/bash
# Generate results.md from raw-logs/ directory.
#
# Reads log files named like:
#   fly-local-disk-small-workload.log
#   docker-archil-disk-medium-workload.log
#
# Each log file should contain lines like:
#   [bench:baseline:small] RESULT pnpm_install=1.622s
#   [bench:baseline:small] RESULT nm_files=2232
#
# Usage: ./generate-results.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RAW_LOGS_DIR="$SCRIPT_DIR/raw-logs"
RESULTS_FILE="$SCRIPT_DIR/results.md"

# ── Extract a RESULT value from a log file ──
# Usage: extract_result <logfile> <key>  →  prints value (e.g. "1.622")
extract_result() {
  local file="$1" key="$2"
  grep "RESULT ${key}=" "$file" 2>/dev/null | sed "s/.*RESULT ${key}=//" | sed 's/s$//' || echo ""
}

# ── Format seconds for display ──
format_time() {
  local val="$1"
  if [ -z "$val" ]; then echo "—"; return; fi
  local int_val
  int_val=$(echo "$val" | cut -d. -f1)
  if [ "$int_val" -ge 60 ] 2>/dev/null; then
    local mins secs
    mins=$((int_val / 60))
    secs=$((int_val % 60))
    echo "${val}s (${mins}m${secs}s)"
  else
    echo "${val}s"
  fi
}

# ── Compute slowdown ──
slowdown() {
  local baseline="$1" archil="$2"
  if [ -z "$baseline" ] || [ -z "$archil" ]; then echo "—"; return; fi
  local ratio
  ratio=$(echo "scale=0; $archil / $baseline" | bc 2>/dev/null)
  if [ -z "$ratio" ] || [ "$ratio" = "0" ]; then
    ratio=$(echo "scale=1; $archil / $baseline" | bc 2>/dev/null)
  fi
  echo "**${ratio}x**"
}

# ── Build a table for one machine type ──
# Usage: build_table <machine_prefix> <heading>
build_table() {
  local prefix="$1" heading="$2"

  echo "## $heading"
  echo ""
  echo "| Workload | Files  | Local disk | Archil | Slowdown |"
  echo "| -------- | ------ | ---------- | ------ | -------- |"

  for wl in small medium; do
    local wl_label files baseline_time archil_time
    local baseline_log="$RAW_LOGS_DIR/${prefix}-local-disk-${wl}-workload.log"
    local archil_log="$RAW_LOGS_DIR/${prefix}-archil-disk-${wl}-workload.log"

    case "$wl" in
      small)  wl_label="Small" ;;
      medium) wl_label="Medium" ;;
    esac

    # Get file count from whichever log exists
    files=""
    if [ -f "$baseline_log" ]; then
      files=$(extract_result "$baseline_log" "nm_files")
    fi
    if [ -z "$files" ] && [ -f "$archil_log" ]; then
      files=$(extract_result "$archil_log" "nm_files")
    fi
    # Format with comma
    if [ -n "$files" ]; then
      files=$(printf "%'d" "$files" 2>/dev/null || echo "$files")
    else
      files="—"
    fi

    baseline_time=""
    if [ -f "$baseline_log" ]; then
      baseline_time=$(extract_result "$baseline_log" "pnpm_install")
    fi

    archil_time=""
    if [ -f "$archil_log" ]; then
      archil_time=$(extract_result "$archil_log" "pnpm_install")
    fi

    local baseline_display archil_display slowdown_display
    baseline_display=$(format_time "$baseline_time")
    archil_display=$(format_time "$archil_time")
    slowdown_display=$(slowdown "$baseline_time" "$archil_time")

    echo "| $wl_label | $files | $baseline_display | $archil_display | $slowdown_display |"
  done

  echo ""
}

# ── Raw logs section ──
build_raw_logs() {
  echo "---"
  echo ""
  echo "## Raw logs"
  echo ""

  for logfile in "$RAW_LOGS_DIR"/*.log; do
    [ -f "$logfile" ] || continue
    local name
    name=$(basename "$logfile" .log)
    echo "### $name"
    echo ""
    echo '```'
    cat "$logfile"
    echo '```'
    echo ""
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

if [ ! -d "$RAW_LOGS_DIR" ]; then
  echo "No raw-logs/ directory found. Run scenarios first with ./run.sh"
  exit 1
fi

{
  echo "# Archil node_modules benchmark"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  build_table "fly" "Fly.io \`lhr\` (London) — 4 shared vCPUs, 4 GB RAM"
  build_table "docker" "MacBook (Docker)"
  build_raw_logs
} > "$RESULTS_FILE"

echo "Wrote $RESULTS_FILE"
cat "$RESULTS_FILE"
