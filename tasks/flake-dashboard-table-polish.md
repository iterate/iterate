---
status: in-progress
size: small
branch: flake-dashboard-table-polish
---

# Flake dashboard: 4-column table, clickable streak squares

Misha reviewed a live mock on issue #2580 (2026-09-04) and approved the layout.

## Status

Spec committed; implementation not started.

## Motivation

The 9-column table is ugly and mostly whitespace. Collapse to
`test | info | stats | streak` with `<br>`-separated lines inside the info and
stats cells. Bonus (requested): each 🟩/🟥/❌ square links to the commit that
produced that outcome, so eyeballing a red square is one click from the run.

## Checklist

- [ ] Render: 4 columns per the approved mock —
      `info` = `pattern: /…/` + `suites: …` + `proposed: …` (proposed line
      only when non-empty); `stats` = `runs:` + `flake rate:` + `last flake:`
      with human-readable UTC dates ("Sep 4, 7:16am"); `streak` = the emoji
      bar with the numeric default-branch streak as a second line
      (`8× pass (main)`) when present.
- [ ] Clickable squares: `recent` entries become `{ outcome, commit }` folded
      from the run-recorded payload's `commit`; render each square as
      `[🟩](https://github.com/<owner>/<repo>/commit/<sha>)` (owner/repo from
      the birth certificate). The commit page links on to its check runs.
      GitHub run/check URLs and Depot run URLs are NOT stored — the commit is
      already in every event and is stable vocabulary; deeper links can come
      later if commit pages prove one click too far.
- [ ] Contract bump 0.3.0 → 0.4.0: recent's shape change refolds the journal,
      which backfills commit links for all existing history.
- [ ] Update flake-dashboard.test.ts render assertions.

## Notes

- The live mock (issue edit 2026-09-04T08:39:56Z) is the source of truth for
  layout; it gets overwritten by the next real render.
- Emoji legend moves into the intro sentence ("Streak = last 10 recorded
  outcomes on any branch, oldest→newest").
