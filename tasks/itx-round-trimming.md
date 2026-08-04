---
status: in-progress
size: medium
---

# Cut agent rounds: toMarkdown text output, docs.search inline expansion, budget-aware truncation notices

## Status summary

Spec fleshed out; implementation not started.

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

- [ ] Add `output?: { format?: "markdown" | "text" }` to `CfMarkdownConversionOptions`
      (apps/os/src/domains/itx/cf-capabilities.ts) and regenerate the API.
- [ ] Teach `output.format: "text"` in the toMarkdown JSDoc overloads and
      `AiRpcTarget.__describe()`: strips link/image URLs — reach for it on emails and
      newsletters, which are dominated by tracking links and giant base64 images.
- [ ] `itx.docs.search`: default page size 12 → 5 via a new `limit` input (clamped),
      and inline the full doc (`docs.get` output) on the top hit via a new `result`
      field on `DocsSearchHit` — count configurable via `expand` (default 1, 0 to
      disable). Update the search JSDoc, `__describe`, and the docs-search-and-get
      example so agents know the top hit usually needs no second call.
- [ ] Budget-aware truncation notices (agent-processor-implementation.ts): the
      oversized-JSON and raw-text spill notices state the inline window, how many
      times over the result was, and — when the result is an array — the per-item
      budget (window ÷ N). Nudge compaction: strip URLs, or convert HTML with
      `conversionOptions.output.format: "text"`.
- [ ] Gmail example: collapse to one-shot — search, fan out `format: "full"` fetches,
      decode, convert every message with `output.format: "text"`, return everything.
      Description teaches both new lessons: use text output for email HTML (tracking
      links, base64 images), and don't over-trim across rounds — return the lot; an
      oversized result comes back as a typed preview plus a spill file to read next
      turn.
- [ ] cf-ai-to-markdown example: demo `output.format: "text"` alongside markdown.
- [ ] Regenerate (`generate:itx-examples`, `generate:itx-api`) and run checks.

## Out of scope

- Raising the 30k `scriptResultHistoryLimit` default (third lever from the analysis;
  separate discussion).
- Escalating/stateful truncation guidance across consecutive truncated rounds — the
  static arithmetic hint comes first; revisit if agents still flail.

## Implementation notes

(log kept while implementing)
