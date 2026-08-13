---
status: done, pending review
size: medium
---

# Lint rule: simple-truthiness-check

Follow-up to `iterate/prefer-logical-and-spread` (#2487).

**Status summary:** done, pending review. Rule (null/undefined/NaN + the
`.length > 0` scope increase) + 11 tests; ~4.6k sites fixed across two sweep
commits (type-aware codemod for the nullish half, `--fix-suggestions` for the
length half); ~30 sites keep precise comparisons with reasoned
oxlint-disable lines; `number-guards.d.ts` (ts-reset-style
`Number.isFinite`/`isInteger` type guards) added per package so the isFinite
escape hatch narrows. Typecheck/lint/knip green; test suite run pending at
last update.

## Ask (verbatim-ish)

Don't compare directly to `null`, `undefined`, or `NaN`.

```ts
// before
...(llm.durationMs == null ? {} : { duration: seconds(llm.durationMs) }),
...(llm.inputTokens == null ? {} : { inputTokens: llm.inputTokens }),

// after (durationMs: number | undefined)
...(Number.isFinite(llm.durationMs) && { duration: seconds(llm.durationMs) }),
...(llm.inputTokens && { inputTokens: llm.inputTokens }),
```

## Principles the rule pushes toward

- `null` and `undefined` almost always mean the same thing. Where they don't,
  fix that place rather than writing careful dual checks.
- `''` usually means the same as null/undefined too (`searchInput === ''` is
  not meaningfully different from "not searching").
- `0` often IS different — escape hatch is a positive number guard:
  `Number.isFinite(x)` / `Number.isInteger(x)`. Prefer positive forms over
  `!Number.isNaN(x)`.
- `x == null` (loose) to paper over null-vs-undefined is a hack.
- Trust the type system: for `{ foo: string } | null`, `if (thing)` suffices;
  no `typeof thing === "object" && thing !== null` dance.

## Decisions (made while fleshing out — assumptions marked)

- [x] Rule `iterate/simple-truthiness-check` in `lint/oxlint-plugin-iterate.ts`,
      flagging `==`/`!=`/`===`/`!==` against `null`, `undefined`, or `NaN`.
      _Also collapses the dual `x !== null && x !== undefined` check into one
      report/fix so applying it yields `x`, not `x && x`._
- [x] **Suggestion-only, not autofix** (per the ask: autofix is risky because
      the rewrite is only equivalent under the principles above, which need a
      human to confirm per site — especially numbers). Two suggestions per
      report, truthiness first, `Number.isFinite` second so IDE users pick.
- [x] Truthiness suggestion is context-aware: bare `x` in boolean contexts
      (`if`/`while`/ternary test, `!`, logical operands feeding those),
      `!!x` where the boolean value itself is used. Parens added when the
      operand binds looser than `!`. _`isBooleanContext` + `BANG_SAFE_EXPRESSION_TYPES`._
- [x] `NaN` comparisons suggest `Number.isNaN(x)` (truthiness doesn't apply;
      direct comparison is always-false). _Zero occurrences in repo today,
      handled for completeness._
- [x] Enable as `"error"` in `.oxlintrc.json` (lint runs `--deny-warnings`, so
      warn vs error is the same in CI).
- [x] Tests in `lint/oxlint-plugin-simple-truthiness.test.ts` mirroring the
      logical-and-spread test style (real oxlint binary in a temp fixture,
      `--fix-suggestions` output asserted). _8 tests._
- [ ] Separate commit(s): experiment applying the suggestions to real code.
      _Assumption: repo has ~3.7k raw comparison sites; if the post-ignore
      count is unmanageable for a reviewable sweep, scope the fix commit to a
      representative slice and document the full count + recommendation in the
      PR body rather than bulk-rewriting semantics-sensitive code._

## Implementation log

- Rule + 8 tests landed. `--fix-suggestions` applies the first suggestion, so
  ordering truthiness first makes bulk application possible while keeping the
  rule suggestion-only for IDE/`--fix` users.
- Armed repo-wide: **3,884 violations in 589 files** (biggest:
  stream-state-panel.tsx 134, rpc-targets.ts 127, stream-event-sender.ts 95).
  A blind `--fix-suggestions` sweep would silently convert number-typed sites
  to truthiness (dropping 0); plan is a type-aware codemod: oxlint JSON spans
  → TypeScript checker classifies each operand (number-ish → `Number.isFinite`
  form, boolean-ish → flag for hand review as tri-state risk, else truthiness).
- Found 2 pre-existing `prefer-logical-and-spread` errors in
  `apps/mobile/src/components/note-composer.tsx` — merge race between #2483
  and the #2487 sweep. Auto-fixed in the fixes commit.
- **Scope increase (mid-flight ask):** `.length > 0` → `.length` and
  `x && x.length > 0` → `x?.length` (guard collapse only when the member
  chain is call/side-effect-free). 755 more sites, applied via
  `--fix-suggestions` with a config arming only this rule.
- **Weakened per follow-up feedback:** `x.length === 0 ? foo : bar` reads
  better than `!x.length ? foo : bar`, so emptiness comparisons used as
  ternary tests are not flagged; the 108 swept instances were reverted to
  the explicit form (optional chains expand to `!x || x.length === 0` —
  `x?.length === 0` would flip the undefined case).
- **Findings from the sweep experiment** (the interesting part):
  - The codemod broke its own rule: `node.value === null` (ESTree Literal)
    became `!node.value`, making the rule flag `x === 0`/`x === false`.
    Poster child for "null is a real value" domains → `lint/**` turns the
    rule off in `.oxlintrc.json`.
  - ~30 more sites keep precise comparisons + reasoned disable lines:
    script results (documented "null is a value a script can return"),
    kv.set validation, OpenAPI 0/false params, stableJson hashing, evlog
    field dropping, live-state diff (undefined = removed), JSON byte
    counting/type inference, frontmatter formatters.
  - `Number.isFinite` doesn't narrow (lib types it `(value: unknown) =>
    boolean`), so the escape hatch un-narrowed ~60 nullable numbers →
    per-package `number-guards.d.ts` types it as a ts-reset-style guard.
    SDK files compiled by scaffolded config templates (packages/iterate
    processors) use native `typeof x === "number"` instead — foreign
    programs don't include our ambient types.
  - Codemod classification bug caught by audit: `string | number`
    unions bucketed as number → `Number.isFinite(part)` silently dropped
    string members (ci-telemetry artifact ids, sandbox `sleepAfter`
    duration strings). Fixed with `x || x === 0` forms.
  - Tests caught the one real behavioral regression: mobile
    repo-working-tree, where `head`/`current` use null as "absent" while
    `""` is real empty-file content — truthiness turned empty files into
    deletes. Reverted with a file-level disable stating the domain rule.
  - TS 5.5 inferred type predicates: `.filter((kid) => kid !== undefined)`
    narrowed, `.filter((kid) => !!kid)` does not → `typeof` filter forms.
  - Full test suite caught six more regressions, all the same shape —
    domains where the null/undefined/'' distinction is a protocol:
    - agent summary updates (null CLEARS a field, omission preserves —
      `applyAgentSummaryUpdate` ended up with a dead clear branch);
      chat-reply-notify + secret `refresh` fold had the same null-clears
      wire semantics on single lines.
    - `config-repo-template-reference` parser: empty ref/path is
      present-and-invalid (must reject), not absent —
      `github:o/r#main&path:` started parsing successfully.
    - test fixtures with tri-state params (telegram `secretToken`, github
      webhook `commentBody`): undefined = valid default, null = omit the
      field — truthiness turned "missing header → 401" tests into 200s.
    - Resolution: file-level disables for protocol files
      (agent-presence, repo-working-tree, template-reference), line
      disables elsewhere. Regenerated `examples.generated.ts` and
      `config-repo-template.generated.ts` after their sources were swept.
  - The preview e2e caught the best class: **validation doors**.
    `x !== undefined && (!isSafeInteger(x) || x < 0)` throws on any
    DEFINED garbage; the sweep's `Number.isFinite(x) && ...` gate skips
    NaN entirely — NaN bound as SQL NULL and a stream DO burned CPU
    instead of throwing. Audited every isFinite-gated throw; restored
    stream offset/limit doors, optimistic-concurrency expectedOffset
    checks, and github history depth with reasoned disables. Also:
    `tsconfig.sdk.json` (files-list config) needed `number-guards.d.ts`
    added explicitly — it was the one program still un-narrowed, which
    broke the publish job.
