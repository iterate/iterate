---
status: in-progress
size: small
follows-up: https://github.com/iterate/iterate/pull/1715
---

# LOC report: show plain and significant line counts side by side

## Status summary

Spec fleshed out, implementation starting. Follow-up to #1715/#1718: the report currently shows
only significant lines (blank lines and JS comments excluded), which hides how much of a change
is comments. Show both counts per group so the gap is visible.

## Motivation

A PR that adds 400 raw lines but only 80 significant ones is mostly comments/whitespace — that's
itself a useful review signal, and today the report silently collapses it. Two columns make the
difference legible at a glance.

## Spec

- [ ] Each group row shows two diff cells: **Lines** (plain `git diff --numstat` counts) and
      **Significant** (existing SLOC counts: blank lines never count, JS comments stripped).
- [ ] The five-square bar stays on the Significant column only (it's the primary signal); a
      comment-only change renders `+N -M` under Lines with an all-empty bar under Significant.
- [ ] Footnote explains the two columns.
- [ ] Local mode prints the same table.

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

(append as work proceeds)
