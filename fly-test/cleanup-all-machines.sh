#!/usr/bin/env bash
set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found" >&2
  exit 1
fi
if [ -z "${FLY_API_KEY:-}" ]; then
  echo "Missing FLY_API_KEY in env" >&2
  exit 1
fi

DRY_RUN=0
ORG_FILTER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --org)
      ORG_FILTER="${2:-}"
      if [ -z "$ORG_FILTER" ]; then
        echo "--org requires value" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: bash fly-test/cleanup-all-machines.sh [--dry-run] [--org <slug>]" >&2
      exit 1
      ;;
  esac
done

export FLY_API_TOKEN="$FLY_API_KEY"

apps_json="$(flyctl apps list --json)"
if [ -n "$ORG_FILTER" ]; then
  apps="$(printf "%s\n" "$apps_json" | jq -r --arg org "$ORG_FILTER" '.[] | select(.Organization.Slug == $org) | .Name')"
else
  apps="$(printf "%s\n" "$apps_json" | jq -r '.[] | .Name')"
fi

if [ -z "$apps" ]; then
  echo "No apps found."
  exit 0
fi

total_apps=0
total_machines=0
failed=0

while IFS= read -r app; do
  [ -z "$app" ] && continue
  total_apps=$((total_apps + 1))
  echo "App: $app"

  if ! machines_json="$(flyctl machine list -a "$app" --json 2>/tmp/fly-machine-list.err)"; then
    echo "  WARN: cannot list machines for app $app"
    sed -n '1,4p' /tmp/fly-machine-list.err | sed 's/^/    /'
    failed=$((failed + 1))
    continue
  fi

  machine_ids="$(printf "%s\n" "$machines_json" | jq -r '.[] | .id')"
  if [ -z "$machine_ids" ]; then
    echo "  No machines."
    continue
  fi

  while IFS= read -r machine_id; do
    [ -z "$machine_id" ] && continue
    total_machines=$((total_machines + 1))
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  [dry-run] would destroy machine $machine_id"
      continue
    fi
    if flyctl machine destroy -a "$app" -f "$machine_id" >/tmp/fly-machine-destroy.err 2>&1; then
      echo "  destroyed $machine_id"
    else
      echo "  ERROR destroying $machine_id"
      sed -n '1,4p' /tmp/fly-machine-destroy.err | sed 's/^/    /'
      failed=$((failed + 1))
    fi
  done <<<"$machine_ids"
done <<<"$apps"

echo ""
echo "Done. apps_scanned=$total_apps machines_seen=$total_machines failures=$failed dry_run=$DRY_RUN"
