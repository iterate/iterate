---
status: in-review
size: small
follows-up: https://github.com/iterate/iterate/pull/1715
---

# LOC report: show plain and significant line counts side by side

## Status summary

Implemented (PR #1723). Each group row now shows raw Lines and Significant counts side by
side, with the five-square bar on Significant.

## Motivation

A PR that adds 400 raw lines but only 80 significant ones is mostly comments/whitespace — that's
itself a useful review signal, and today the report silently collapses it. Two columns make the
difference legible at a glance.

## Spec

- [x] Each group row shows two diff cells: **Lines** (plain `git diff --numstat` counts) and
      **Significant** (existing SLOC counts: blank lines never count, JS comments stripped).
- [x] The five-square bar stays on the Significant column only (it's the primary signal); a
      comment-only change renders `+N -M` under Lines with an all-empty bar under Significant.
- [x] Footnote explains the two columns.
- [x] Local mode prints the same table.

## Decisions / assumptions (made while AFK)

- **Bar scales by significant churn**, not raw churn — consistent with it living in the
  Significant column, and keeps generated/lockfile noise from dominating the scale when it's
  in the raw column only.
- Column headers: `Lines` and `Significant`. Short enough for the table, footnote carries the
  definition.
- `ChangedFile` keeps raw `added`/`removed` from numstat and gains
  `significantAdded`/`significantRemoved` (equal to raw for binary files: 0). No optional
  fields.

## Implementation log

- `ChangedFile`/`GroupRow` carry both raw (`added`/`removed`, straight from numstat) and
  `significantAdded`/`significantRemoved` (stripped-content diff) - the SLOC counts no longer
  overwrite the raw ones.
- Sanity check on merged sandbox PR (3296aa87a): raw Total +1,939 -315 matches the original
  pre-SLOC report exactly; significant Total +1,316 -200 matches the SLOC-only report.
  CI & scripts shows the comment gap nicely: +156 raw vs +66 significant.
