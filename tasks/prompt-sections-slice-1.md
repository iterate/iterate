---
status: in-progress
size: large
parent: prompt-sections-tree
---

# Prompt sections, slice 1: tree fold + segments at append + id-ops

First slice of [prompt-sections-tree](prompt-sections-tree.md) (the approved
decision record — read it first; its decisions are not re-litigated here).

## Scope

IN:
- Fold state becomes the two-lane section tree: standing prefix (canonically
  ordered children: protocol, config sections in a stable order, hot sections
  last) and turns (offset-ordered). Depth 1: sections are flat children of
  their lane.
- `agents/context-added` learns optional `segments: [{sectionId, content}]`;
  a tagged-file parser at append time (authoring syntax → segments) so
  templates can author one file with `<section id>` tags; plain messages stay
  untouched (one implicit turn node).
- New `agents/context-updated` op event: `op: replace | delete`, selectors
  `#id` and `*`, `mode: "append-latest"` opt-in. Collapse semantics always
  for replace/delete (no covered/uncovered behavioral switch).
- Deterministic keyed-vocabulary mapping: old `payload.key` events reduce
  into the tree (`key` → sectionId; uncovered-replace → collapse;
  covered-append → append-as-latest). One fold, no legacy reducer;
  pre-migration requests render under the new fold (inspector labels them
  "reconstructed under the current fold").
- Renderer: tree → messages, standing lane first in canonical order, turns by
  offset; per-request timestamp stays the render-time tail.
- Sectionize `prompts/agent-system-prompt.md` (id'd sections: identity,
  capabilities tour, output-formatting, summary-instruction, …).
- Templates: codemode-tag replaces ONLY `#output-formatting` (retiring its
  forked whole-prompt file, or shrinking the fork to the one section);
  default template's prompt supersession and house-style ride sections.
- Migrate every `state.contextItems` reader: agent-llm-request prompt build,
  lib/llm-request-replay + inspector UI, agent-prompt-budgets test,
  codemode-tag/default sync helpers (`findLast(key)` shapes).
- Contract version bump; full test migration; new specs for: id-replace
  collapse (cache-relevant orderings asserted), append-latest, `*` delete,
  keyed-event mapping, canonical standing order regardless of arrival order.

OUT (later slices / explicitly deferred):
- Provenance & derived roles (slice 2) — `role` stays stored on segments.
- Range selectors (`turn:before(N)`) and the compaction rebuild (slice 3) —
  today's compaction event keeps working, re-expressed minimally against the
  turns lane with unchanged semantics.
- Placement ops (insert-before/after): deferred unless trivial; canonical
  ordering covers hot-last without them.

## Checklist

- [ ] Spec commit (this file + the decision record)
- [ ] Contract: segments on context-added; `agents/context-updated`; state
      schema = two-lane tree; version bump
- [ ] Fold: tree reduce incl. keyed mapping + op application
- [ ] Renderer + canonical standing order; timestamp tail preserved
- [ ] Append-time tagged-file parser (authoring syntax)
- [ ] Compaction re-expressed against turns lane (semantics unchanged)
- [ ] Reader migrations (llm-request, replay/inspector, budgets, templates)
- [ ] Sectionized default prompt; codemode-tag one-section override
- [ ] Tests per scope; format → lint:fix → knip → full suite
- [ ] Draft PR, preview e2e green

## Implementation log

- 2026-08-24: worktree created off main; spec committed first.
