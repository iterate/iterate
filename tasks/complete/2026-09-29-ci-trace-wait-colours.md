---
size: small
---

# CI trace: waits striped, colours shown on parent rows

Status: done. Waits carry the `wait` phase; each row takes the colour its running children share.

The CI trace legend has a striped yellow "Waiting" colour, but only the workflow queue used it: "Wait for Deploy preview" and "Wait for the shards" drew as plain blue.

A row should also show its children's colour where they all agree: "Wait for Deploy preview" makes that stretch of "E2E tests" striped. Where two children run side by side with different colours (one waiting, one testing), the parent keeps its own colour for that stretch.

- [x] "Wait for …" operations drawn as waiting _`traceOperation({ name, phase: "wait" }, …)` in preview.ts and specs-shards.ts; the phase travels in the span-start marker to `ci.phase`_
- [x] a row takes a colour for any stretch where every child running then has it _`segments()` in scripts/ci/tracing/viewer.html, worked out bottom-up_
- [x] children with different colours, or none running, leave the parent's own colour _a child with no colour counts as its own colour when checking agreement, but never paints its parent_
- [x] failed or unfinished rows stay recognisable _red or grey outline on a bar that takes its children's colours_
- [x] "Set up the suite" and the specs' warm-up drawn as setup _so a test job's bar reads setup → wait → tests → finish_

## Implementation notes

- Checked against Main OS e2e run 6tnf4l0rj2 (7f2887a2), with the new phases added to its trace.json by hand: E2E tests striped 17.1–50.4 s, Browser specs only while it and all ten shards waited, the workflow row only for 49.0–49.9 s.
- Reports made before this change keep plain "Wait for" bars: their markers have no phase.
