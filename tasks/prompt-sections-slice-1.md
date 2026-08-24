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

## Status summary

Implementation essentially complete: contract v7 (two-lane state, segments,
context-updated op event), fold rewritten, renderer + canonical order,
parser shared via `iterate/processors`, compaction re-expressed, all readers
migrated, both templates converted, tests migrated plus the new specs.
Remaining: preview e2e verification (e2e suites updated but only runnable
against a deployed env).

## Checklist

- [x] Spec commit (this file + the decision record) — _commit ce164d3d6_
- [x] Contract: segments on context-added; `agents/context-updated`; state
      schema = two-lane tree; version bump — _agent-processor-contract.ts:
      7.0.0; `standingSections` + `turns` replace `contextItems`; section-id
      constants (umbrella, file sections, hot) live here too_
- [x] Fold: tree reduce incl. keyed mapping + op application —
      _agent-prompt-fold.ts: `projectContextAdded` (segments / keyed mapping /
      implicit turn), `applyContextUpdated`, `writeStandingSection` (umbrella
      write clears prompt-file sections — the old-worker double-prompt guard)_
- [x] Renderer + canonical standing order; timestamp tail preserved —
      _standing prefix flatMapped ahead of turns in
      `buildAgentLlmRequestBody`; order maintained in state by
      `compareStandingSections` (prompt sections in file order, boot context,
      others alphabetical, hot last); clock still the last message_
- [x] Append-time tagged-file parser (authoring syntax) —
      _`parsePromptSections` in
      packages/iterate/src/processors/prompt-sections.ts (shared: platform
      birth defaults AND template workers import it); untagged content lands
      in a caller-named fallback section, so old untagged files keep working_
- [x] Compaction re-expressed against turns lane (semantics unchanged) —
      _turns: system facts kept ahead of the summary, post-barrier turns
      behind it; standing sections collapse to latest occurrence (the cache
      rebaseline the old keyed retain did)_
- [x] Reader migrations (llm-request, replay/inspector, budgets, templates) —
      _agent-llm-request hasHistory → turns; turn-loop gate + presence
      runnable → `hasSystemPromptStandingSection`; replay exposes
      `reconstructed` (requested events now stamp `contractVersion`;
      inspector + round-meta YAML label older-fold replays); pretty-state
      renders the two lanes; budget test measures parsed model-visible chars_
- [x] Sectionized default prompt; codemode-tag one-section override —
      _configs/default/prompts/agent-system-prompt.md wears `<section id>`
      tags (ids pinned against the contract list by agent-defaults.test.ts);
      codemode-tag's fork shrank to just the grammar section, applied via
      `context-updated` replace `#output-formatting` at birth and on commit_
- [x] Tests per scope; format → lint:fix → knip → full suite —
      _agent-prompt-fold.test.ts carries the new specs (id-replace collapse
      with byte-level cache assertions, append-latest, `*` delete, keyed
      mapping, canonical-order-vs-arrival-order, umbrella supersession);
      parser specs in packages/iterate; full local suite green_
- [ ] Draft PR, preview e2e green — _PR #2512 open (draft); e2e assertions
      updated for the new state shape but need a preview run_

## Implementation log

- 2026-08-24: worktree created off main; spec committed first.
- 2026-08-24: core migration (commit b1d6a5011), tests + templates follow-up.
  Judgment calls, in decision order:
  - **State shape**: two top-level fields (`standingSections`, `turns`)
    rather than one nested tree object — flatter for consumers, and the two
    lanes ARE the whole tree at depth 1. Occurrences store the full context
    payload (with `key` set to the sectionId) so the renderer and
    pretty-state read one shape for both lanes.
  - **Readiness gate**: the spec's "standing lane has a
    `#agent/system-prompt` section" is honored as: umbrella section OR any
    sectionized-prompt-file section (`SYSTEM_PROMPT_STANDING_SECTION_IDS`).
    Segment births produce `identity` etc., never the umbrella, so the
    literal check alone would hold triggers forever.
  - **Umbrella supersession**: any write to `agent/system-prompt` deletes
    the prompt-file sections. Needed because ALREADY-DEPLOYED default-template
    workers supersede the whole prompt via the keyed umbrella after the
    platform birth appends segments — without this every new agent in an old
    project would carry a double prompt. One-directional on purpose:
    section-level writes never delete the umbrella (deleting a full prompt
    because one section changed would lobotomise old agents).
  - **Keyed mapping**: uncovered-replace = collapse the WHOLE section (old
    code retained earlier covered occurrences and replaced only the latest;
    decision 10 says collapse, and reconstructibility lives in the events).
  - **Canonical order for unknown sections**: alphabetical (deterministic,
    arrival-independent). Template-specific ids (house-style, onboarding-*)
    are deliberately NOT hardcoded platform-side.
  - **Unkeyed system-role items** stay in the turns lane (no sectionId to
    address them by); compaction keeps them, moved ahead of the summary —
    old semantics preserved.
  - **"Reconstructed" detection**: `llm-request-requested` now stamps
    `contractVersion`; a replay whose stamp differs from the current
    contract version (or is absent — all pre-7.0.0 requests) is labeled
    reconstructed. Deterministic, and survives future fold versions.
  - **Idempotency-key renames** (`agent/system-prompt-segments:…`,
    `iterate/config/agent-system-prompt-segments:…`, house-style `:v2`):
    the event BODIES changed shape while their content-hash revisions
    didn't, and a re-create over an existing agent must supersede, not trip
    same-key-different-body.
  - **Budget test** now measures the parsed segments' content (the tags are
    authoring syntax and never reach a model); the raw tagged file exceeds
    the old raw-length ceiling by ~400 chars of tags.
  - **codemode-tag scope**: the old fork also adapted the summary teach and
    the tour to the codemode dialect; the one-section replacement folds the
    essentials into `#output-formatting` (status-is-activity note plus a
    bridging line: "```ts examples elsewhere go INSIDE your tag"). Slight
    dialect-fidelity loss vs the full fork, accepted to honor "replace ONLY
    #output-formatting". Pre-existing codemode agents (old keyed conversion
    = umbrella section) that the new worker sweeps get the grammar section
    ADDED next to their full codemode umbrella prompt — redundant but
    coherent; noted, not fixed.
  - Placement ops (insert-before/after): NOT implemented — nothing in this
    slice needed them (canonical order covers hot-last).
  - MCP prompts: `DEFAULT + suffix` parses to the file's sections plus the
    suffix as an umbrella segment. Two consequences shaped the design: the
    umbrella clearing is applied once per EVENT before its writes (so a
    mixed event never clears its own sibling sections — regression test in
    agent-prompt-fold.test.ts), and the umbrella's canonical slot sits AFTER
    the file sections (its untagged content is a trailing addendum — the MCP
    note says "overrides the guidance above" — while a whole-prompt umbrella
    stands alone anyway, making its slot moot).
