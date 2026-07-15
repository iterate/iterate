# OpenCode v2 learning interview — append-only log

Started: 2026-07-15 (Europe/London)

Purpose: grill Jonas on which OpenCode lessons Iterate should adopt, reject, or investigate. This file is append-only. Each round preserves Jonas's response verbatim, then records an explicit interpretation, tension, decision, or follow-up. Later clarification may supersede an earlier interpretation, but earlier text is never rewritten.

Background:

- [Chronological OpenCode research](./opencode-v2-research-log.md)
- [Consolidated architecture assessment](./opencode-v2-architecture-assessment.md)

## Entry 001 — request to begin the interview

### Jonas, verbatim

> OK can you now grow me and keep a log of what I say on things we maybe could learn from OpenCode or not? I don't know.

### Working interpretation

“Grow me” is understood phonetically as “grill me.” The uncertainty is part of the task: the interview should expose preferences and contradictions rather than ask Jonas to arrive with a settled list. Questions should force architectural tradeoffs, one at a time, and distinguish adopting an invariant from copying an implementation.

## Entry 002 — question: is the journal sufficient authority?

### Question

Iterate says state is a fold over the append-only journal and checkpoints are disposable. OpenCode compromises that in its fork: replaying the child can consult the parent's current projection and produce a different result later.

Would you make this a hard Iterate invariant—**a Stream plus immutable referenced content must always be sufficient to reconstruct its semantic state without reading another live projection**?

Saying yes means accepting larger self-contained facts/snapshots, retaining historical decoders, and treating cross-stream projections as rebuildable indexes. Saying no permits cheaper lineage references and authoritative materialized views, but “refold” is no longer local or necessarily time-stable.
