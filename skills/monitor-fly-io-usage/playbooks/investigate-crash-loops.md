# investigate-crash-loops

Use when machines repeatedly restart or fail readiness.

## Checks

1. Count restart frequency and affected machines.
2. Classify failure mode: boot failure, readiness failure, runtime crash.
3. Correlate with recent deploys/config/env changes.
4. Identify immediate mitigation (rollback, config revert, scale change, restart).

## Evidence format

- window:
- app/machine:
- restart pattern:
- failure signature:
- suspected trigger:
- mitigation applied/proposed:
- links:
