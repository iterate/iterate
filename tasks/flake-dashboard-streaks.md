---
status: in-progress
size: small
branch: flake-dashboard-streaks
---

# Flake dashboard: row expiry, emoji streaks, createFailing rename

Three follow-ups from the first live week of the flake dashboard (#2580), agreed in discussion 2026-09-03.

## Status

Implemented and pushed; awaiting CI + review. All checklist items done: expiry
+ emoji bar in the dashboard reducer/render (contract 0.2.0), createFailing
rename across 10 files + docs. 20/20 dashboard tests, shared + renamed-callsite
suites green, typecheck/lint/knip clean. Bugbot found the default-branch
expiry judgment never fires for PR-only suites (specs/preview-e2e); reworked
to a 3-run any-branch window, tests updated.

Known follow-up (pre-existing, out of scope): `defaultBranchStreak` — and
therefore transition proposals — also never fires for PR-only suites.

## Motivation

Renaming the chat-photos test in PR #2584 split its dashboard row in two: the
old name (`multiple photos share a mosaic row; …`) is frozen at 1 run / 100%
forever, next to the new name's row. More generally, deleted tests never leave
the table.

Decision: **the test name is the identity, and rows expire by absence.** No
rename detection, no lineage linking, no stable-id API. A rename resets the
streak — you touched the test, so fresh stats are honest — and history stays
readable in the issue's edit history and replayable from the immutable
`/flakes` event log. Expiry is a pure projection choice in the reducer/render:
nothing is deleted, so a transiently-absent row comes back with its full
history the next time it records.

## Checklist

- [x] Row expiry (absence-based): a test row renders only if it appeared in
      at least one of the last **3** `run-recorded` events (any branch) of one
      of its suites. _Originally specced as default-branch-judged with N=1;
      bugbot correctly flagged that specs/preview-e2e only run on PRs
      (cloudflare-previews.yml has no push trigger), so a default-branch
      reference point would never exist for them and the motivating
      chat-photos row could never retire. The 3-run window replaces the
      default-branch guard as the protection against one PR push hiding a row
      repo-wide. State: per-suite `recentRunOffsets` (≤3) + per-test
      `lastSeenOffset`._
- [x] Expired rows are hidden from the table, not dropped from state. Footer
      gains a one-liner: `_N retired tests hidden (no longer present in the
      latest default-branch run of their suite)._` when N > 0.
- [x] Emoji streak column: each tracked test keeps its last 10 outcomes
      from **any branch** (ring buffer in reduced state, oldest first).
      _Any-branch for the same reason as expiry: PR-only suites would
      otherwise have permanently empty bars; matches the all-branch counts and
      flake-rate columns. `defaultBranchStreak` stays main-only._
      Render as a `recent` column: 🟩 pass, 🟥 flake-fail, ❌ unexpected-error,
      oldest→newest. The existing numeric `default-branch streak` column stays
      (it carries the transition-threshold counts past 10).
- [x] Contract: new fields with defaults so existing prd state parses
      untouched; bump contract version 0.1.0 → 0.2.0.
- [x] Harness tests in flake-dashboard.test.ts: rename splits then retires the
      old row on the next default-branch suite run; transient absence
      (PR-branch run without the test) does NOT retire; retired row revives
      with history intact when the name records again; emoji bar renders and
      caps at 10.
- [x] `failing(…)` → `createFailing(…)` rename for consistency with
      `createFlake` (both are two-level: `createX(test, …)` returns the
      registrar). Rename the export in
      packages/shared/src/test-support/failing-test.ts, update the
      docstring + log-message strings ("delete the createFailing() wrapper"),
      and all callsites (9 files, see notes). Filename stays failing-test.ts.
      No deprecated alias — few callsites, and an alias defeats the
      less-confusing goal.
- [x] Sweep doc references to `failing(` (docs/testing.md etc.).

## Non-goals / explicitly rejected

- Rename detection or a stable-id param on createFlake/createFailing.
- Deleting expired tests from reduced state (a lazy GC can come later if state
  size ever matters; the log is the source of truth regardless).
- Renaming the `switch-to-failing` transition enum value or any durable event
  shape — event values are append-only vocabulary.

## Notes

- `failing(` callsites on main: failing-test.ts, failing-test.test.ts,
  flake-test.ts (docstring), userspace-facet-source-version.e2e.test.ts,
  userspace-facet-recycle-false-alarm.e2e.test.ts,
  project-create-concurrency.regression.e2e.test.ts,
  abandoned-project-goes-quiet.e2e.test.ts,
  oversized-settlement-isolate.e2e.test.ts, artifact-rpc-ownership /
  scheduler-rpc-ownership / guarantees-not-given / oversized-settlement-crash
  tests.
- Conflict heads-up: PR #2575 (oversized-settlement-repro) edits
  failing-test.ts (adds the vitest `retry: 0` pin) and
  oversized-settlement-isolate.e2e.test.ts. This branch keeps its
  failing-test.ts diff to the mechanical rename only, so the merge either way
  is small; whichever lands second merges main and fixes up.
