---
status: in-progress
size: large
parent: prompt-sections-tree
---

# Prompt sections, slice 1: tree fold + segments at append + id-ops

First slice of [prompt-sections-tree](prompt-sections-tree.md) (the approved
decision record — read it first; its decisions are not re-litigated here).

> **Note (2026-08-24 evening):** the IN list below is the ORIGINAL slice
> spec. The interactive-demo review revised the vocabulary afterwards — see
> the decision record's revision note and this file's second log entry; the
> demo (docs/prompt-sections-demo.html) is authoritative where they differ
> (no context-updated event; re-adding a key is the update; one standing
> document message; permanent send stamps; script durations).

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

Implemented, then REWORKED to the final vocabulary settled in the
interactive-demo review (docs/prompt-sections-demo.html — see the dated
revision note in the decision record): re-adding a key IS the update
(adaptive placement: un-sent coalesces, sent lands temporally with
supersedes), `agents/context-rewritten` for rare deliberate rewrites, the
standing lane rendered as ONE tagged system document, permanent "Requested
at:" send stamps replacing the render-time tail (every request a strict
byte-superset of the last), and script settlements rendered with measured
durations. Remaining: preview e2e verification (e2e suites updated but only
runnable against a deployed env).

## Checklist

- [x] Spec commit (this file + the decision record) — _commit ce164d3d6_
- [x] Contract: segments on context-added; the rewrite event; state schema =
      the two lanes; version bump — _agent-processor-contract.ts: 7.0.0;
      `standingSections` (flat entries) + `turns` (timeline union) replace
      `contextItems`; `agents/context-rewritten` (context-updated died in the
      demo review); section-key constants live here too_
- [x] Fold: adaptive placement + rewrite application —
      _agent-prompt-fold.ts: `projectContextAdded`/`addKeyedOccurrence`
      (coalesce-unsent / temporal-with-supersedes / standing-vs-temporal
      first placement), `applyContextRewritten`, umbrella clearing (the
      old-worker double-prompt guard)_
- [x] Renderer + canonical standing order; the clock —
      _`buildAgentLlmRequestBody`: protocol, ONE tagged standing-document
      system message (canonical order via `compareStandingSections`), the
      timeline; the render-time tail became the permanent "Requested at:"
      send stamp each request reduces into the timeline_
- [x] Append-time tagged-file parser (authoring syntax) —
      _`parsePromptSections` in
      packages/iterate/src/processors/prompt-sections.ts (shared: platform
      birth defaults AND template workers import it); untagged content lands
      in a caller-named fallback section, so old untagged files keep working_
- [x] Compaction re-expressed against the timeline (semantics unchanged) —
      _system facts kept ahead of the summary, post-barrier turns and stamps
      behind it; every section collapses to its newest occurrence, folded
      back into the standing document_
- [x] Reader migrations (llm-request, replay/inspector, budgets, templates) —
      _agent-llm-request hasHistory → turns; turn-loop gate + presence
      runnable → `hasSystemPromptStandingSection`; replay exposes
      `reconstructed` (requested events now stamp `contractVersion`;
      inspector + round-meta YAML label older-fold replays); pretty-state
      renders the two lanes; budget test measures parsed model-visible chars_
- [x] Sectionized default prompt; codemode-tag one-section override —
      _configs/default/prompts/agent-system-prompt.md wears `<section key>`
      tags (keys pinned against the contract list by agent-defaults.test.ts);
      codemode-tag's fork shrank to just the grammar section, re-added as a
      plain keyed context-added at birth and on commit (coalesces inside the
      birth window)_
- [x] Tests per scope; format → lint:fix → knip → full suite —
      _agent-prompt-fold.test.ts carries the final specs (one-document
      render + birth-window coalesce, temporal-with-supersedes byte-prefix,
      strict byte-superset across requests, standing-vs-temporal first
      placement, rewrite replace/delete/`*`, canonical-order-vs-arrival,
      umbrella supersession, temporal coalesce); parser specs in
      packages/iterate; full local suite green_
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

### 2026-08-24 (evening): rework to the final vocabulary

The interactive-demo review with Misha rewrote decisions 4, 5, 6, 12 (see
the decision record's revision note; docs/prompt-sections-demo.html is the
authoritative artifact, committed with this pass). What changed here:

- `agents/context-updated` deleted. Re-adding a `key` IS the update:
  `projectContextAdded` now implements adaptive placement (un-sent latest
  occurrence → edit in place; sent → temporal append with `supersedes`
  stamped by the fold; first-ever → standing document only while no
  conversation exists). `sectionId` renamed to `key` everywhere, including
  `segments: [{key, content}]` and the parser's `<section key="...">`
  authoring tags (same tags the renderer emits — unforked files round-trip
  byte-identically).
- New rare `agents/context-rewritten` (`{op: replace|delete, key,
  content?}`, no selector grammar; `key: "*"` deletes everything, both
  lanes). replace rewrites the standing document in place and drops the
  key's temporal occurrences.
- State: `standingSections` became flat single-occurrence entries
  `{key, offset, payload}`; `turns` became the TIMELINE — a union of plain
  turns, temporal section items `{offset, section: {key, supersedes?},
  payload}`, and send stamps `{offset, requestedAt}`.
- Renderer: protocol, then ONE system message (the tagged standing
  document, canonical order, hot last), then the timeline. The render-time
  timestamp tail is gone: each `llm-request-requested` reduces a permanent
  "Requested at:" developer line into the timeline, so request N+1's render
  strictly starts with request N's byte-for-byte (spec'd in
  agent-prompt-fold.test.ts).
- Script durations: `activeScriptExecutionIds` became
  `activeScriptExecutions` (`{executionId, requestedAt}`); the platform
  codemode settlement render and codemode-tag's vendored twin now say
  "Your script returned (in 1.8s):" — derived from the requested/settled
  events' journaled createdAt, never wall clock (the codemode-tag worker
  reads the requested event back with a narrow typed getEvents, since the
  capability-host settlement payload carries no timing).
- Templates: both workers now use plain keyed `agents/context-added` for
  birth reactions and syncs; the content-equality skip is kept to avoid
  appending an identical temporal copy to a SENT section (on an un-sent one
  it would merely coalesce). context-updated usage removed.

Judgment calls in this pass:

- The demo's reference table says the stamp renders as the "Current date
  and time" line while its own fold renders "Requested at: <ISO>"; the
  coordinator's instruction says "Requested at:" — followed that, and gave
  the protocol prompt one line teaching that the newest stamp is the
  current time.
- The protocol prompt got a MINIMAL accuracy edit (standing document +
  supersedes semantics + the stamp line; the stale keyed-item/@offset
  sentences dropped). The full rewrite stays slice 2 as planned.
- A guarded (no-op) `llm-request-requested` — late debounce loser, paused —
  stamps nothing: only a request that actually OPENS renders a stamp, since
  re-reduction replays the same guards deterministically.
- An un-sent TEMPORAL occurrence coalesces in place too, keeping its
  supersedes anchor (two rapid post-send syncs produce one update, not a
  stack) — demo-consistent (its coalesce branch is placement-agnostic).
- `context-rewritten replace` folds the section back into the STANDING
  document (matching the demo's rewrite branch) and inherits the section's
  role; replace on a missing key creates it (system role).
- Compaction now also consumes temporal occurrences: every section
  collapses to its newest occurrence AS STANDING ("rides until compaction
  collapses to latest"); post-barrier stamps survive at their positions,
  pre-barrier stamps are summarized away with the turns they timed.
- The umbrella supersession (writes to `agent/system-prompt` clear the
  prompt-file sections, per event, both lanes) and the canonical order
  (file sections, umbrella, boot-context, others alphabetical, hot last)
  carried over unchanged from the first pass, as instructed.
- Idempotency-key bumps for changed bodies: platform prompt append
  `agent/system-prompt-segments:v2:…`, default worker
  `iterate/config/agent-system-prompt-segments:v2:…`, house-style `:v3`.
  The AGENTS.md sync deliberately reuses the OLD worker's exact key format
  AND body shape (`iterate/config/agents-md:<hash>:after-<off>` + keyed
  context-added), so old-worker and new-worker syncs of the same transition
  dedupe against each other.
