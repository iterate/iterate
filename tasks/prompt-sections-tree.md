---
status: ready
size: large
---

# Prompt sections: from keyed context slots to a two-lane section tree

Settled via a use-case-driven plannotator interview (11 rounds, approved
2026-08-24). Each decision below was banked against a concrete use case, most
of them incidents or clumsiness from the agent-birth work (#2508).

## Decisions

1. **Operations are events; the rendered request is a fold.** Events stay
   the sole truth; every past request reconstructible pinned to its offset.
2. **No separately-stored document.** The tree is fold state / pure
   projection — nothing maintained beside the events.
3. **Sub-message sections; structure established at append time; ops never
   parse model-visible strings.** Authors may write one tagged file; the
   appending code parses it once. (Proven by: codemode-tag forking the whole
   prompt to change one section; the channel-prompt clobber bug.)
4. **Standing sections collapse on update by default; append-as-latest is an
   explicit opt-in; hot standing sections (AGENTS.md) render last in the
   prefix** so their updates bust only their own cache suffix.
5. **Collapse vs correct is the author's explicit per-event choice; the
   covered/uncovered switch is demoted to barrier bookkeeping.** (Proven by:
   the p1711 double-system-prompt trace.)
6. **Compaction is a generic range-replace** (`turn:before(N)` + summary
   content); the barrier derives from the op; whoever may replace may
   compact.
7. **Un-saying takes plain append rights.** No platform placeholder;
   redaction content is author-supplied; `delete *` deletes everything —
   guidance ("don't, unless you want a lobotomised agent"), not guardrails.
   The op event's audit trail is the safeguard.
8. **Provenance-first sections; role derived at render** via one pure
   `(provenance, placement) → role` function; platform-only roleOverride for
   structural sections; the append-time gate decides claimable provenance
   (the slack router mints `verified: misha`, a config worker cannot).
9. **No expiry attribute.** Ephemera are ordinary turn content — models can
   see the conversation moved on; the per-request timestamp stays a
   render-time tail, never an event.
10. **One fold, deterministic keyed-vocabulary mapping** (`key` →
    `sectionId`; uncovered-replace → collapse; covered-append →
    append-as-latest); pre-migration requests labeled "reconstructed under
    the current fold", not byte-exact.
11. **Shape: the section tree, scoped.** Exactly two top-level lanes —
    standing prefix (canonically ordered: protocol, config in stable order,
    hot sections last) and turns (offset-ordered). Depth capped at 1 until a
    use case forces nesting; placement ops (insert-before/after) on the
    standing lane only. Inline HTML survives as authoring syntax; render
    serializes the tree to messages.
12. **Vocabulary:** new `agents/context-updated` op event
    (`replace`/`delete`, selector, content/segments, append-latest mode,
    placement); selectors `#id`, `*`, `turn:before(N)` — the grammar grows
    only when a use case forces it. `agents/context-added` unchanged for
    plain messages (an implicit turn node).

## Checklist (one PR per slice; fold + templates + tests + state-reader migrations together)

- [ ] Slice 1: tree fold + segments-at-append + id-ops (`#id`, `*`) — retires
      #2508's whole-slot prompt replacement; codemode-tag replaces only the
      dialect section; AGENTS.md updates collapse cleanly; migrate
      `state.contextItems` readers (request inspector, budgets test,
      codemode-tag sync helpers).
- [ ] Slice 2: provenance + derived roles; routers mint verified identity;
      protocol prompt rewritten.
- [ ] Slice 3: range-replace + compaction rebuilt on it; delete today's
      compaction special case.
