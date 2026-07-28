#!/usr/bin/env bash
set -euo pipefail

artifact_root="${1:-test-results}"
manifest="$artifact_root/artifact-manifest.txt"

mkdir -p "$artifact_root"

{
  echo "Collected preview test artifacts at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo
  echo "Source paths:"
  echo "- test-results"
  echo "- apps/os/test-results"
  echo "- apps/os/e2e/tui-test/tui-traces"
  echo "- apps/streams-example-app/test-results"
  echo "- /tmp/os-e2e-*"
  echo "- /tmp/os-preview-*.log"
  echo "- /tmp/marathon"
  echo
} > "$manifest"

copy_dir_contents() {
  local source_dir="$1"
  local destination_dir="$2"

  if [[ ! -d "$source_dir" ]]; then
    echo "missing directory: $source_dir" >> "$manifest"
    return 0
  fi

  mkdir -p "$destination_dir"
  cp -a "$source_dir"/. "$destination_dir"/
  echo "copied directory: $source_dir -> $destination_dir" >> "$manifest"
}

copy_files() {
  local destination_dir="$1"
  shift

  if [[ "$#" -eq 0 ]]; then
    echo "missing files for destination: $destination_dir" >> "$manifest"
    return 0
  fi

  mkdir -p "$destination_dir"
  cp -a "$@" "$destination_dir"/
  printf "copied file(s) to %s:\n" "$destination_dir" >> "$manifest"
  printf -- "- %s\n" "$@" >> "$manifest"
}

# Playwright writes directly to the repo-level artifact root. Keep that as the
# upload root, and fold absolute/temp outputs underneath it so Depot does not
# need to upload from mixed workspace and /tmp paths.
copy_dir_contents "apps/os/test-results" "$artifact_root/apps-os-test-results"
# Microsoft TUI Test keeps its PTY trace (frames, events, output) at the
# app-local project root configured by e2e/tui-test/run.ts.
copy_dir_contents "apps/os/e2e/tui-test/tui-traces" "$artifact_root/apps-os-tui-traces"
# The streams example app's Playwright lane writes traces and its JSON report
# under its own app directory (app-local playwright.config.ts).
copy_dir_contents "apps/streams-example-app/test-results" "$artifact_root/apps-streams-example-app-test-results"
copy_dir_contents "/tmp/marathon" "$artifact_root/marathon"

shopt -s nullglob
os_e2e_roots=(/tmp/os-e2e-*)
os_preview_logs=(/tmp/os-preview-*.log)
# Named /tmp telemetry files exist only for the orchestrator's immediate retry
# summary. Every reporter also writes the canonical copy under the artifact
# root's ci-telemetry/raw directory, so copying a second hard-coded file list
# here would create a drift-prone duplicate source of truth.
if ((${#os_e2e_roots[@]} == 0)); then
  copy_files "$artifact_root/os-e2e"
else
  copy_files "$artifact_root/os-e2e" "${os_e2e_roots[@]}"
fi

if ((${#os_preview_logs[@]} == 0)); then
  copy_files "$artifact_root/os-preview-logs"
else
  copy_files "$artifact_root/os-preview-logs" "${os_preview_logs[@]}"
fi

echo >> "$manifest"
echo "Collected files:" >> "$manifest"
find "$artifact_root" -mindepth 1 -maxdepth 5 -print | sort >> "$manifest"

echo "Preview test artifact root: $artifact_root"
find "$artifact_root" -mindepth 1 -maxdepth 3 -print | sort
