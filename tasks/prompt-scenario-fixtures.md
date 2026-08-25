---
status: in-progress
size: medium
---

# Prompt scenario fixtures

**Status summary**: spec committed, implementation not started. Main pieces:
fixture format + harness, scenario migration from the explainer, generated
explainer page, mini-fold deletion.

The interactive explainer (`explainers/prompt-sections.html`) carries its own
hand-written mini-fold and hand-written "rendered request" outputs. That was
right for designing the system; now that the real fold is merged (#2512) the
explainer's scenarios should become **data fixtures managed by tests**: the
scenario events are input data, the rendered provider requests are
snapshot-alike output data produced by the REAL fold
(`reduceAgentEvents` + `buildAgentLlmRequestBody`), and the explainer page is
generated from the fixtures. Direct inspiration: the sqlfu repo's generate
fixtures (`~/src/sqlfu/packages/sqlfu/test/generate/fixtures/validators.md`
parsed by `fixture-helpers.ts`, refreshed via a vitest `updateSnapshots`
provide flag).

## Decisions (best-guess where Misha hasn't specified — marked ⚠️)

1. **Location**: `apps/os/src/domains/agents/prompt-scenarios/` — one
   fixture `.md` per scenario, plus `fixture-helpers.ts`,
   `prompt-scenarios.test.ts`, and the explainer generator. Fixtures sit next
   to the fold they exercise.
2. **Fixture file format** (sqlfu-style markdown):
   - Intro prose at the top = the scenario's explainer intro, verbatim.
   - One `<details><summary>events</summary>` block holding a single
     ` ```yaml (events.yaml)` fence: the ordered event list. Each entry:
     `off`, `t` (elapsed-time label like `"1.9s"`), `type` (short form,
     `agents/context-added` etc.), `payload`, and `note` (the LHS card
     caption). A scenario can declare `base: <other-scenario>` in the fence
     to prepend that scenario's events (scenario 1b/3b build on 1).
   - One `<details><summary>request @N</summary>` block **per
     `llm-request-requested` event**, each holding a
     ` ```yaml (request@N.yaml)` fence: the rendered provider request at that
     offset, as produced by the real fold. These are the snapshot-writable
     outputs; `-u` regenerates them, plain runs assert byte-equality.
     ⚠️ requests-only (not request-so-far at every event) — the actual sends
     are the thing worth pinning; the page doesn't need perfect parity.
   - An optional ` ```yaml (annotations.yaml)` fence inside the events block:
     a list of `{request: "@26", find: "<substring of a rendered line>",
     comment: "<text>"}`. The harness inserts `# <text>` comment lines above
     the first output line containing the substring — this is how the
     hand-written inline commentary survives regeneration: comments are
     *declared against the expected output* and re-applied on every render,
     never hand-edited inside the snapshot. An annotation whose `find`
     matches nothing fails the test (stale annotation = broken explainer).
3. **Harness** (`fixture-helpers.ts`): parse fixture → synthesize
   `StreamEvent`s → for each request offset run the REAL
   `buildAgentLlmRequestBody({events, llmRequestOffset})` → render stable
   YAML (small deterministic printer, comments injected per annotations) →
   compare or rewrite the fixture's output fences. Update mode via the sqlfu
   pattern: `provide: {updateSnapshots: process.argv.includes("-u") || …}` in
   `apps/os/vitest.config.ts`, read with `inject()`.
4. **Explainer page is generated, but by the test — not eslint-plugin-codegen.**
   ⚠️ Deviation from the original sketch, for a mechanical reason: our lint
   is oxlint and `codegen/codegen` only runs on files oxlint lints — it will
   never visit an `.html` file, so lint can't keep the page fresh. Instead
   the same test suite owns it: a generator renders
   `explainers/prompt-sections.html` from (a) a static shell — header,
   opinion box, vocabulary tables, appendices A–E preserved byte-for-byte —
   and (b) embedded JSON scenario data derived from the fixtures. In `-u`
   mode it writes the file; otherwise it asserts the committed page matches.
   Same enforcement property codegen would have given, one mechanism for
   fixture outputs and page both.
5. **The page's mini-fold JS is deleted.** The page keeps a thin renderer
   over precomputed data: clicking an event card shows the nearest covering
   pinned request (or the "no change / due to be sent" note derived from
   debounce data included in the embedded JSON). Slight interactivity loss
   vs. computing request-so-far per click — accepted per "doesn't need
   PERFECT parity, just needs to successfully explain".
6. **Scenario migration**: port scenarios 1, 1b, 2, 3a, 3b, 4, 5 from the
   page's current JS data into fixtures. The real fold is the truth: where
   its output differs from the hand-written mini-fold's, keep the real
   output and adjust event payloads/notes only as needed to stay
   illustrative. 3a (the anti-pattern) must keep reading as an anti-pattern.
7. **Serving unchanged**: the generated file keeps its path, so the prod
   `/explainers/prompt-sections` route and sync flow are untouched.

## Checklist

- [ ] vitest `updateSnapshots` provide flag in apps/os/vitest.config.ts
- [ ] fixture format parser + YAML renderer + annotation applier
      (fixture-helpers.ts), with a focused unit test
- [ ] scenario fixtures ported (1, 1b, 2, 3a, 3b, 4, 5) with outputs
      generated by the real fold and annotations carrying the existing
      commentary
- [ ] prompt-scenarios.test.ts: one test per scenario asserting outputs +
      annotations up to date; `-u` rewrites
- [ ] explainer generator: static shell + embedded fixture-derived JSON →
      explainers/prompt-sections.html; test asserts freshness; mini-fold
      deleted; appendices A–E byte-identical
- [ ] page still explains: scenario intros, event cards with notes, request
      YAML with comments, anti-pattern warnings, deep links (#scenario@off)
- [ ] docs breadcrumb: short note in apps/os/AGENTS.md or docs/testing.md
      pointing at the fixture workflow (`pnpm vitest -u` to refresh)

## Implementation log

(append as you go)
