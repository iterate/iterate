---
status: in-review
size: small
branch: itx-example-seedance-video
pr: https://github.com/iterate/iterate/pull/2522
---

# itx example: Seedance 2.0 video generation

## Status summary

Implementation done, PR open (draft). Example added, generated file
regenerated, typecheck/lint/knip/format + all 83 src/itx tests green.
Remaining: review-bot wave + human review.

## Why

Cloudflare acquired Replicate and `bytedance/seedance-2.0` is now a
first-class Workers AI model. It works TODAY through the existing zero-config
`itx.ai.run()` surface — verified 2026-08-26 on prod project `misha`:

```ts
await itx.ai.run("bytedance/seedance-2.0", {
  prompt: "a red ball rolling on a white table",
  duration: 4,
  resolution: "480p",
  aspect_ratio: "16:9",
})
// → { state: "Completed", result: { video: "https://ark-acg-....volces.com/....mp4?...24h-signed..." },
//     gatewayMetadata: { keySource: "Unified" } }
```

But yesterday a prod web agent, asked to make a Seedance video, wrongly
replied "not available" because:

- `itx.ai.models()` only returns the classic `@cf/*` catalog — partner models
  (`bytedance/*`, `xai/*`) never appear there
- `itx.docs.search` has no seedance/video hit that mentions this

So the example's summary text IS the fix: it's what makes agents discover
this via `itx.docs.search`.

## Spec

- [x] Add `ai-generate-video-seedance` example to
      `apps/os/src/itx/examples-source.ts`, modeled on the existing
      `ai-generate-video` (grok) entry: `e2eProven: false`,
      `INTERACTIVE_RUNTIMES` (paid/remote AI infrastructure), link
      https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/
      _added right after the grok entry, same `run<T>` local-shape pattern_
- [x] Description must explicitly say partner models like
      `bytedance/seedance-2.0` do NOT appear in `itx.ai.models()` (classic
      `@cf/*` catalog only) but work directly via `itx.ai.run()` — that
      sentence is the docs-search discoverability fix
      _description says exactly this, plus "do not conclude a model is
      unavailable just because models() omits it"_
- [x] Note in the example that `result.video` is a ByteDance-hosted signed
      URL that expires (~24h) — download/store to keep it
      _in the description and as an inline comment on `videoUrl`_
- [x] Give the sibling `ai-generate-video` (grok) description the same
      one-line models()-under-reporting clarification (small tasteful edit)
      _one added sentence: "Note: partner models like xai/* and bytedance/*
      do not appear in itx.ai.models() ... but work directly via
      itx.ai.run()."_
- [x] Regenerate `examples.generated.ts` (`pnpm generate:itx-examples`),
      AFTER `pnpm format`
      _done in that order; format idempotent afterwards_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format` + relevant
      tests before pushing
      _all clean; all 83 tests in apps/os/src/itx pass_

### Model params (from Cloudflare docs)

`prompt` (≤2000 chars, required), `duration` 4–12s, `resolution`
480p/720p/1080p/4K, `aspect_ratio` 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 |
9:21; optional reference images (≤9), reference videos (≤3), audio files
(≤3), `seed`, watermark toggle, audio-generation flag.

## Implementation log

- The examples-typecheck contract test typechecks each generated body against
  the REAL itx surface, where `ai.run` returns `unknown`. Like the other
  `ai-*` media entries, the new one reads `result.video`, so it needed a
  `SURFACE_GAPS` excuse in `examples-typecheck.test.ts` ("same run<T>
  constraint as ai-generate-image"). The test enforces the excuse is real: if
  the surface ever gains a typed `run<T>`, the excuse must be deleted.
- No other generated artifacts involved — `examples.generated.ts` is the only
  derived file, freshness enforced by `examples.generated.test.ts`.
