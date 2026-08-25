---
status: in-review
size: medium
---

# Prompt scenario fixtures

**Status summary**: implemented, PR in review. All seven scenarios live as
markdown fixtures whose request outputs come from the real fold; the explainer
page is generated from them (mini-fold deleted, appendices byte-identical);
`-u` regenerates everything, plain runs assert freshness. Remaining: review.

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

- [x] vitest `updateSnapshots` provide flag in apps/os/vitest.config.ts
      _`test.provide.updateSnapshots` from `-u`/`--update` in process.argv;
      read via `inject()` (module augmentation in fixture-helpers.ts)_
- [x] fixture format parser + YAML renderer + annotation applier
      (fixture-helpers.ts), with a focused unit test
      _fixture-helpers.ts (parse/synthesize/validate/render/weave/regenerate)
      + fixture-helpers.test.ts; every synthesized event is validated against
      the contract's consumed-event schema so a typo'd payload fails loudly
      instead of silently dropping from the render_
- [x] scenario fixtures ported (1, 1b, 2, 3a, 3b, 4, 5) with outputs
      generated by the real fold and annotations carrying the existing
      commentary
      _1-birth.md … 5-unsay.md; outputs include a derived ✂ cache-cut comment
      marking divergence from the previous request in the chain_
- [x] prompt-scenarios.test.ts: one test per scenario asserting outputs +
      annotations up to date; `-u` rewrites
      _one test per fixture file + one for the generated page; both share the
      regenerate-in-memory-then-compare path_
- [x] explainer generator: static shell + embedded fixture-derived JSON →
      explainers/prompt-sections.html; test asserts freshness; mini-fold
      deleted; appendices A–E byte-identical
      _explainer-shell.html (thin renderer, no fold) + explainer-generator.ts
      (cards, badges, sched notes from real reduced state, pane titles);
      opinion box, vocab tables, and appendices verified byte-identical to
      the previous committed page_
- [x] page still explains: scenario intros, event cards with notes, request
      YAML with comments, anti-pattern warnings, deep links (#scenario@off)
      _verified in a live browser: default lands on birth@26, card clicks
      update pane/hash, ⚠ rewrite badges, ✂ + comment line styling, shared
      base blocks, deep link #british@80 selects and renders on load_
- [x] docs breadcrumb: short note in apps/os/AGENTS.md or docs/testing.md
      pointing at the fixture workflow (`pnpm vitest -u` to refresh)
      _docs/testing.md, "Data fixtures with regenerable outputs"_

## Implementation log

- Sources studied: agent-prompt-fold.ts (+ its spec for event literals),
  agent-processor-contract.ts payload schemas, the capability-host contract
  (script-run payloads), sqlfu's fixture-helpers.ts + vitest.config.ts, and
  the full explainer page.
- The real fold forced scenario adjustments the mini-fold never needed
  (spec decision 6 says the real fold wins; all deltas below keep each
  scenario's teaching intact):
  - `llm-request-settled` events between turns: the reduce ignores a new
    requested event while another request is open, so every scenario with
    two requests carries settlements (birth @29, script @35/@40, 3a/3b @75,
    legacy @38, unsay @94). The harness fails loudly when a pinned requested
    event reduces to nothing.
  - `llm-request-requested` requires `expiresAt`: the harness derives it
    (event time + 30s) when a fixture payload omits it — expiry is turn-loop
    machinery, irrelevant to what the scenarios teach; an explicit value
    wins. Same for `capability-host/script-run-requested`.
  - Script settlements carry no duration field; the rendered "(in 1.8s)"
    duration derives from the requested→settled createdAt gap, so 1b's
    timestamps were set to make that arithmetic true (@34 at 10m 14.2s, @36
    at 10m 16s).
  - Scenarios 2, 4, and 5 gained a closing user message + request pair so
    each pins the render its intro tells the reader to look at (@64, @82,
    @92/@97). Scenario 5 also pins the post-`delete` render before the
    `delete *` lobotomy.
  - 3a: a `context-rewritten` replace that CREATES a key lands at the
    collection's tail (temporal position), not in the standing document —
    the fold's applyContextRewritten appends first occurrences. The @80
    replace then swaps content at @70's position, above the lowercase reply
    it contradicts, and the ✂ line visibly jumps up (cache bust). Intro and
    notes rewritten to describe that real behavior; scenario 4's @80 note
    likewise (a first-ever key with conversation present renders temporally,
    never joins the standing document).
- Page generation: the shell is the committed page minus the script block —
  the header paragraph now describes pinned fixtures instead of a live
  mini-fold (the orchestrating prompt scoped byte-for-byte preservation to
  the opinion box, vocab tables, and appendices; the header had to change to
  stay truthful). Scenario JSON embeds per-card precomputed pane titles and
  scheduling notes (from the real fold's pendingLlmRequestTrigger + debounce
  config), and request bodies keyed `<owningScenario>@<offset>` so child
  scenarios reuse base renders. `</` is JSON-escaped so no content can close
  the embedding script tag.
- ProvidedContext knock-on: augmenting it for `updateSnapshots` closed the
  empty-interface loophole the e2e vitest config's `provide` relied on; that
  config now declares its four keys.
- oxfmt ignores the fixture .md files, the shell, and the generated page
  (YAML fences and generated bytes must not be reflowed).
- Verified: unit + scenario + page tests green in assert mode and after a
  full `-u` cycle; apps/os typecheck, repo lint, knip clean; page exercised
  in a live browser (cards, pane, badges, sched lines, deep links).
- Review follow-up (Misha): the pane now shows the request-so-far AS OF the
  clicked event again — the generator computes a fold render per chain event
  and embeds it in the page JSON (fixture files unchanged: they keep only
  the per-request fences). At a requested offset the embedded snapshot IS
  the pinned fence, byte for byte (asserted in prompt-scenarios.test.ts; the
  client-side reconstruction was hash-verified against the committed fence
  in a live browser). Line-diff highlighting restored via
  `import("https://esm.sh/diff@8.0.4")` in the shell (page degrades to
  no-highlights if the import fails): each snapshot diffs against the
  PREVIOUS EVENT's — added lines green (`--add`), remove+add pairs yellow
  (`--chg`), bare removals a red strip (`--del`, new) on the first surviving
  line. Identical renders show the old "ⓘ no change to the rendered
  request" note (old wording for configure events; a turn-loop-machinery
  variant for settlements/script events, which the old page didn't have).
  Verified: birth @5/@9/@22/@25/@26, 3a @70/@80/@84 (one yellow in-place
  swap vs 3b @80's five green appended lines — the contrast), legacy @80,
  unsay @90 (red strip) and @95 (churn).
- Embedding stays ~237KB (the old page was ~103KB): per-event renders are
  suffix-encoded against the previous event's comment-free render (the
  superset property makes suffixes small) with woven `#` comments carried as
  [index, text] inserts, replayed exactly by the client.
- ✂-vs-diff baselines differ by design: the harness-woven ✂ line marks
  divergence from the previous REQUEST (what the provider cache actually
  compares at a send), while the click-time highlights diff against the
  previous EVENT. At 3a's @84 the ✂ therefore sits up at the rewritten rule
  while the green lines mark only the stamp — both true, each labeled.
- Review follow-up (Misha): declared abridgements in the render layer — the
  printer replaces long fold-injected boilerplate with the explainer's short
  stand-in before printing, keyed on the imported constant itself
  (AGENT_CONTEXT_PROTOCOL_PROMPT, now exported from agent-prompt-fold) so
  the mapping breaks loudly rather than rotting. The protocol renders as the
  page's original one-liner ending in "…"; fences and page snapshots share
  the pass (renderMessageLines), so the byte-identity test still holds.
  Audit of all fences found no other long fold-injected text — every other
  long-ish line is a fixture-authored stand-in already ending in "…".
  #birth@5 renders as 6 lines. Page: 227KB.
