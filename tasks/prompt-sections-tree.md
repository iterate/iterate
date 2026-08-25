---
status: ready
size: large
---

# Prompt sections: from keyed context slots to a section tree

Settled via a use-case-driven plannotator interview (11 rounds, approved
2026-08-24). Each decision below was banked against a concrete use case, most
of them incidents or clumsiness from the agent-birth work (#2508).

> **Revised 2026-08-24 (evening), after the interactive-demo review** —
> [docs/prompt-sections-demo.html](../docs/prompt-sections-demo.html) is the
> authoritative artifact; decisions 4, 5, 6 (partially), and 12 below are
> rewritten to match it. What changed and why:
>
> - **Collapse-in-place for standing edits was wrong.** The standing document
>   precedes every turn, so ANY standing edit busts the provider cache for
>   the entire conversation behind it — and a replaced covered behavioral
>   rule manufactures "history contradicts my instructions" (the model looks
>   like it has been refusing to comply; demo scenario 3a). Both problems
>   vanish when a sent section's update lands AT ITS MOMENT IN TIME instead.
> - **So the everyday op event died: re-adding a `key` IS the update.** The
>   adaptive placement rule (un-sent → coalesce in place, free; sent →
>   temporal append with `supersedes`; first-ever → standing if no
>   conversation exists yet) is deliberately the old covered/uncovered rule —
>   re-derived from first principles three times during the demo iteration.
>   Old streams' keyed events already mean exactly this: no legacy mapping.
> - **`agents/context-updated` became `agents/context-rewritten`** — rare,
>   audited, named to discourage: deliberate history rewriting only
>   (redaction, un-saying, `delete *`), with plain `{op, key, content?}`
>   fields instead of a selector grammar.
> - **The render-time timestamp tail died too**: every
>   `agent/llm-request-requested` renders permanently into the timeline as a
>   "Requested at:" developer line — the one machinery event with a rendered
>   face — making each request's prompt a strict byte-superset of the
>   previous one (maximal cache reuse under every regime).
> - The standing collection renders as **ONE system message**: the tagged document
>   (`<section key="...">` blocks) — byte-identical to the authored prompt
>   file on an unforked project. Temporal occurrences render at their offset
>   as `<section key supersedes="@N">` messages.
>
> **Revised again 2026-08-25 — arbitrary keys.** The kernel must not know
> key meanings: the four named-key constants (umbrella, prompt-file
> sections, readiness keys, hot keys) are gone, and with them the umbrella
> supersession (no key ever triggers clearing of another key — a
> whole-prompt-keyed section and file sections coexist as plain sections;
> the rare doubled mix on old streams is closed by a prd repo sweep, not by
> kernel key-smarts), the canonical-order comparator (ordering is pure
> FIRST-APPEARANCE: commit order, segments keeping their file order — hot
> content lands last in every real flow because the worker's reaction
> arrives after the birth batch; authors control placement through append
> order, and an attribute-based ordering feature can be added if genuinely
> needed), and the turn loop's readiness gate (every creation path ships
> prompt content in the atomic birth batch, so the hold was vestigial; the
> presence facet generalizes to "any system-role section exists").
> - Script settlements render WITH the script's measured duration (derived
>   from the requested/settled events' journaled createdAt) — slow operations
>   become knowable to the model.

> **Revised 2026-08-25 (second) — one collection, derived document.** The
> reduced state is a single offset-ordered `contextItems` array (a proper
> discriminated union: `kind: "message" | "section" | "request"`). The
> standing document is DERIVED AT RENDER — the collection's leading run of
> section items, ending at the first message, send stamp, or superseding
> occurrence, merged into one tagged system message. Reasons: one collection
> is the simplest state that supports every behavior (the update rule is a
> findLast-and-coalesce over one array; readers ask one question of one
> shape); document membership is a fact of position — a section stands
> exactly when nothing conversational precedes it — so there is no partition
> to keep consistent with the render; and compaction's rebuild (newest
> occurrence per key in first-appearance order, unkeyed system facts, the
> summary, the post-barrier tail) reads directly as the array it produces.
> Renders are byte-identical under this state model — the byte-superset and
> first-appearance specs pass untouched.

> **Revised 2026-08-25 (third) — one event per section.** `agents/context-added`
> has exactly one shape: optional `key`, plus `content` and the ordinary
> fields — no bundled multi-section variant, no cross-field constraint. A
> parsed prompt file becomes a BATCH of keyed events, one per section, in
> file order; the append batch already commits atomically in input order, so
> file order becomes offset order becomes document order, and no render can
> see a half-written prompt. Each section occurrence owns its own offset, so
> `supersedes` points at exact occurrences. Idempotency keys go per section:
> `<base>:<index>:<sectionKey>` (the index disambiguates repeated keys, e.g.
> several untagged runs of one file).

## Decisions

1. **Operations are events; the rendered request is a fold.** Events stay
   the sole truth; every past request reconstructible pinned to its offset.
2. **No separately-stored document.** The tree is fold state / pure
   projection — nothing maintained beside the events.
3. **Sub-message sections; structure established at append time; ops never
   parse model-visible strings.** Authors may write one tagged file; the
   appending code parses it once. (Proven by: codemode-tag forking the whole
   prompt to change one section; the channel-prompt clobber bug.)
4. **(Revised) Re-adding a key IS the update — adaptive placement.** An
   occurrence no request has sent yet is edited in place (coalesced, free —
   the whole birth window); a sent one appends at the tail of the timeline,
   at its moment in time, with `supersedes` stamped by the fold; a first-ever
   key joins the standing document only while no conversation exists. Hot
   sections (AGENTS.md) still render last in the standing document. The
   superseded copy rides until compaction collapses each section to latest —
   the price of a coherent timeline and an intact cache, and the right trade.
5. **(Revised) Temporal position is the coherence mechanism; the
   covered/uncovered rule is the placement rule.** Nothing above a temporal
   update can contradict it — no marker text needed — and the whole prefix
   stays byte-stable. The everyday author never chooses collapse vs correct;
   `agents/context-rewritten` (replace/delete, plain `{op, key, content?}`)
   exists for DELIBERATE history rewriting only — redaction, un-saying,
   `delete *` — and is named to discourage casual use (a bare replace of a
   sent behavioral rule is the scenario-3a anti-pattern: demo 3a vs 3b).
6. **Compaction is a generic range-replace** (`turn:before(N)` + summary
   content); the barrier derives from the op; whoever may replace may
   compact. (Slice 3; today's compaction event keeps working, and also
   collapses each section to its newest occurrence, folded back into the
   standing document.)
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
11. **(Revised) Shape: the section tree, scoped.** Exactly two top-level
    collections — the standing document (protocol message first, then sections in
    FIRST-APPEARANCE order; keys are arbitrary strings the kernel never
    interprets, and placement is guidance — append order — not mechanism)
    and turns (offset-ordered). Depth capped at 1 until a use case forces
    nesting. Inline HTML survives as authoring syntax; render serializes
    the tree to messages.
12. **(Revised) Vocabulary: two events.** `agents/context-added` is the
    everyday event — the only one most authors ever use: without `key` a
    turn; with `key` (or `segments: [{key, content}]` for many at once)
    keyed standing content under the adaptive placement rule. The rare
    `agents/context-rewritten` (`{op: replace|delete, key, content?}`, plain
    fields, no selector grammar; `key: "*"` = everything, standing document
    and timeline both) is
    deliberate history rewriting. The send stamp is not an event at all:
    `agent/llm-request-requested` projects into the timeline as the
    permanent "Requested at:" line — no separate timestamp event, no
    floating tail.

## Checklist (one PR per slice; fold + templates + tests + state-reader migrations together)

- [x] Slice 1: _done — PR #2512 (task record: tasks/complete/2026-08-25-prompt-sections-slice-1.md); the design evolved during review: arbitrary keys, one contextItems collection, one event per section, permanent send stamps_
      Slice 1 original scope: tree fold + segments-at-append + id-ops (`#id`, `*`) — retires
      #2508's whole-slot prompt replacement; codemode-tag replaces only the
      dialect section; AGENTS.md updates collapse cleanly; migrate
      `state.contextItems` readers (request inspector, budgets test,
      codemode-tag sync helpers).
- [ ] Slice 2: provenance + derived roles; routers mint verified identity;
      protocol prompt rewritten.
- [ ] Slice 3: range-replace + compaction rebuilt on it; delete today's
      compaction special case.
