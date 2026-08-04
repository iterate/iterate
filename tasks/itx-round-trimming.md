---
status: in-review
size: medium
pr: https://github.com/iterate/iterate/pull/2409
---

# Cut agent rounds: toMarkdown text output, docs.search inline expansion, budget-aware truncation notices

## Status summary

Implemented, all checks green (typecheck, lint, knip, 251 test files), PR open as
draft. All checklist items done.

## Motivation

After the ai.run/toMarkdown docs fixes (#2399) and the truncation preview improvement
(#2400), a re-run of the "summarise five FirstFT emails" task still took NINE rounds
(`agents/mobile/2026-08-04t13-52-08-431z`). The transcript shows the remaining waste:

- Rounds 5–8 were budget-blind: each edition's converted markdown was ~63k chars —
  ~90% of it FT tracking-link URLs — and the agent kept returning 60–150k against the
  ~30k window, trying a different slicing heuristic each time. The truncation notice
  never told it the arithmetic.
- Cloudflare toMarkdown natively fixes the noise: `conversionOptions.output.format:
  "text"` strips link targets and image URLs entirely (verified against prd). But our
  published `CfMarkdownConversionOptions` type doesn't declare `output`, so agent
  scripts can't use it (excess-property error), and nothing documents it.
- Round 2 was a whole round just to `docs.get` the top search hit — search already
  named the right thing first.
- Rounds 3+4 could have been one script: the agent over-trimmed (metadata-only round)
  when a single "fetch everything, return it all" script would have let the
  truncator's typed preview + spill file do their job.

## Checklist

- [x] Add `output?: { format?: "markdown" | "text" }` to `CfMarkdownConversionOptions`
      _(cf-capabilities.ts; regenerated into both itx-api.generated.ts copies)_
- [x] Teach `output.format: "text"` in the toMarkdown JSDoc and `AiRpcTarget.__describe()`
      _(rpc-targets.ts single-doc overload + describe child blip: "emails and
      newsletters are mostly tracking links and giant base64 images — often 10x smaller")_
- [x] `itx.docs.search`: `limit` (default 5, clamp 1–25) + `expand` (default 1, clamp
      0–limit) inlining the full doc on top hit(s) via new `DocsSearchHit.result`
      _(rpc-targets.ts search; DocsSearchHit in itx-api-graph.ts; search JSDoc,
      DocsRpcTarget __describe, docs-search-and-get example, exec-typescript step 2,
      and the system-prompt docs teach line all updated — prompt revision 8 → 9,
      trimmed to stay inside the 4200-token ceiling rather than raising it)_
- [x] Budget-aware truncation notices
      _(agent-processor-implementation.ts: new `resultBudgetArithmetic` appended to
      both the oversized-JSON and raw-text spill notices — states the inline window,
      how many times over the result was, per-item budget when the result is an
      array, and points at URL-stripping / output.format "text" compaction)_
- [x] Gmail example one-shot rewrite
      _(examples-source.ts: list → fan out format:"full" → decode → toMarkdown with
      output text for EVERY hit, one return; description teaches "don't spread
      list/read across turns, don't pre-trim — oversized returns degrade to typed
      preview + spill file")_
- [x] cf-ai-to-markdown example demos `output.format: "text"`
      _(same doc converted both ways; description carries the email/newsletter hint)_
- [x] Regenerate and run checks
      _(generate:itx-examples + generate:itx-api after format; typecheck, lint, knip,
      full apps/os suite 251 files green)_

## Out of scope

- Raising the 30k `scriptResultHistoryLimit` default (third lever from the analysis;
  separate discussion).
- Escalating/stateful truncation guidance across consecutive truncated rounds — the
  static arithmetic hint comes first; revisit if agents still flail.

## Implementation notes

- `output.format: "text"` verified against prd before implementing: link targets and
  image URLs are dropped, link text and alt text kept.
- The docs teach line in the default prompt had ~11 chars of headroom under the
  4200-token ceiling (revision 8 was itself a post-merge budget trim), so the new
  sentence is compensated by tightening the same line ("example scripts (most PROVEN —
  run unattended by the test suite), type declarations" → "examples (most PROVEN,
  CI-run), types").
- `expand` fetches run through the same `docs.get` path as a manual call, so a type
  hit inlines its declaration closure under the default 1500-token budget.
