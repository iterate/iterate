# Facet lifecycle plan review — Claude Opus 5.5

Command: `claude -p --model claude-opus-5-5 --effort xhigh --output-format json --permission-mode dontAsk`.
Raw response: `/tmp/facets-plan-opus.json`.

## Decision

Do not merge all facet state into one record. Keep the existing large startup
memo and split lifecycle state into a small control row and an identity row:

- control: `ran`, claim, claim failures, restart count;
- identity: loader ID and optional named-worker record;
- memo: remain `facet:<name>`.

The reviewer found that a record containing the memo is unsafe: claim and run
writes would rewrite source, can exceed the source cell ceiling, and birth or
quiet scans would load every source. Reusing `facet:<name>` would also confuse
an extant lifecycle record with a hosted spec.

## Required constraints

- The `FacetHost` constructor must not write or migrate: birth starts must
  happen before the first parent commit.
- New readers need new-else-old fallback for claims, `ran`, identity, named
  worker and restart count; losing any old row loses a required recovery.
- Deferred writes must patch a field at write time, not persist a captured
  record snapshot, because a claim or deletion can land while a recovery waits.
- The generation and outcome maps do not all share a lifetime. In particular,
  outcome generations must survive deletion to protect a later re-created
  facet from an old instance's timeout.
- Migrate old rows only after birth starts, and delete them atomically with the
  new small rows.

## Classifier finding

The proposed use of `isLoadedWorkerPlatformFailure` for facets is not safe yet.
Facet tests inject opaque error text from loaded code, whose errors can carry
`remote: true`; the existing facet classifier treats those as recoverable.
Production telemetry currently logs only the message, so it cannot establish
whether the actual platform fault has `remote`. The review recommends logging
`remote` and `failureKind` at the facet recovery sites and adding an explicit
parent-side failure injection before changing classifier behaviour.

## Required tests before migration

1. A fake-host write-fence test proving no KV write falls between each abort and
   successor startup attempt.
2. Workers migration test seeded with old-shaped rows, covering birth start,
   first-party due claims, retained failed-revive backoff, loaded claim timing,
   identity change and processor restart count.
3. Races: deletion during recovery must not restore state; old-instance timeout
   after delete/recreate must not restart the new facet.

The full independent review is retained in `/tmp/facets-plan-opus.json`.
