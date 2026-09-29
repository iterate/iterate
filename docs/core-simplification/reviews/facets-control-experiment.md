# Parked facet control-row experiment

The experiment is retained at
`/tmp/core-simplification-facet-control-experiment.patch`. It combined `ran`,
claim, revive-failure count, and loader-recovery count in `facet-control:<name>`
and combined the loader ID and named-worker generation in
`facet-identity:<name>`. The large startup memo stayed separate.

The source change is deliberately parked. It changed 92 lines and deleted 66
(net +26): it reduced key families, but did not make a lifecycle transition
atomic or make its live and durable views one state. The two rows still needed
separate selection, durable commit, deletion, and late-attempt rules.

## Review evidence

Claude Opus 5.5 reviewed the actual diff with xhigh reasoning. The command was
`claude -p --model claude-opus-5-5 --effort xhigh --output-format json
--permission-mode dontAsk`; its successful raw result is
`/tmp/facets-diff-opus.json` and stderr is `/tmp/facets-diff-opus.stderr`.

It found these material hazards:

1. A selected in-memory loader ID can advance before startup; deciding whether
   to persist from that selected ID loses durable catch-up after a failed start.
2. A resolver path without a named-worker generation can overwrite the durable
   monotonic generation with `undefined`, allowing publication rollback.
3. A delayed recovery write after deletion can recreate a control or identity
   row unless it is fenced by the hosting memo/generation.

The first defect was corrected locally before parking by comparing scheduling
against the durable identity row, but the other two demonstrate the design
problem: grouped storage fields do not eliminate the separate protocol states.

## State assessment

The experiment made only these storage-key states impossible: a separate
`facet-ran`, claim, failure-count, or restart-count row can no longer be
present independently. It did **not** make impossible the difficult states:

- selected identity ahead of durable identity while startup awaits;
- an old materialization resuming after a replacement or deletion;
- a publication generation advancing while an older resolver is in flight;
- abort followed by startup with no intervening parent commit.

The architecture candidate should make code identity immutable at publication,
then make the supervisor own the mutable facet lifetime. That removes the
need to infer a worker identity from mutable source/producer resolution during
each facet lifecycle transition. The remaining platform recovery generation
must stay separate because it describes a loader isolate, not published code.
