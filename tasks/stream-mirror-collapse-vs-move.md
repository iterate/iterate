---
state: todo
priority: medium
size: small
dependsOn: []
tags: [os, streams, browser-mirror, iterate-package, decision]
---

# Decide: collapse the browser stream mirror first, or move it into the package first

Jonas's direction (2026-07-17 jam): the SQLite/feed plumbing should ALSO live
in `packages/iterate` eventually — "use the same plumbing for populating a
SQLite database and having feed items and all that jazz".

The tension: moving the mirror (~6k LOC movable core per the #2063-era sweep)
drags the `stream-processor` / `stream-processor-runner` family with it (the
browser hosts processors via the same runner the DOs use) — while
`apps/os/docs/stream-mirror-collapse.md` (written during #2048) designs the
OPPOSITE: server-owned feed live view + cursor-paged history, then DELETE
~4,850 LOC of the mirror. Moving code that is slated for deletion is churn.

This task is the DECISION, not the work: pick collapse-first (Phases A–D in
the design doc, then move what survives) or move-first (accept the runner
family relocating), and spawn the real tasks from the choice. Inputs:
the collapse design doc, `docs/frontend-development.md`'s "one exception"
section, and PR #2063's next-steps list.
