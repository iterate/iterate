#!/usr/bin/env bash
# THE TEST JOB'S PNPM STORE LINE (docs/depot-ci.md#the-test-job-runs-on-depots-stock-image). The
# restore from Depot Cache and main's save are `continue-on-error`, so neither decides the job. This
# writes a line of the job's summary: which store the install started from, and main's save. A
# restore or save whose outcome is `failure` (its timeout) is also a warning. actions/cache reports
# most other trouble as a warning in its own log and succeeds: a restore that could not read Depot
# Cache looks like a miss, and a store Depot Cache refused looks like a save. Plain shell.
#
#   bash scripts/ci/pnpm-store-report.sh <restore outcome> <primary key> <matched key> <save outcome>
set -u

restore="${1:-}" primary="${2:-}" matched="${3:-}" save="${4:-}"

if [ "$restore" = failure ]; then
  echo "::warning title=pnpm's store not restored::the restore from Depot Cache failed (its timeout, or its log says why); the install fetched what it lacked from the npm registry"
  line="the restore failed (its timeout, or its log says why), and the install fetched what it lacked from the npm registry"
elif [ "$restore" != success ]; then
  line="none restored (the restore's outcome: ${restore:-none})"
elif [ -z "$matched" ]; then
  line="none restored (none saved yet, or the restore could not read Depot Cache: its log says which), and the install fetched every package from the npm registry"
elif [ "$matched" = "$primary" ]; then
  line="restored this lockfile's, \`$matched\`"
else
  line="none saved for this lockfile (\`$primary\`), so it restored the newest, \`$matched\`, and the install fetched the rest"
fi

case "$save" in
  success) line="$line. Main saved this lockfile's store for the next runs (a store Depot Cache refused is a warning in the save's log)" ;;
  failure)
    echo "::warning title=pnpm's store not saved::the save to Depot Cache failed (its timeout, or its log says why); runs of this lockfile restore an older store, or none on main, until a main push saves one"
    line="$line. The save failed (its timeout, or its log says why), so runs of this lockfile restore an older store, or none on main, until a main push saves one"
    ;;
esac

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "**pnpm's store**: $line." >>"$GITHUB_STEP_SUMMARY"
fi
exit 0
