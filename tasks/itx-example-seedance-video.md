---
status: in-progress
size: small
branch: itx-example-seedance-video
---

# itx example: Seedance 2.0 video generation

## Status summary

Spec committed; implementation not started yet. Next: add the example to
examples-source.ts, regenerate, run checks.

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

- [ ] Add `ai-generate-video-seedance` example to
      `apps/os/src/itx/examples-source.ts`, modeled on the existing
      `ai-generate-video` (grok) entry: `e2eProven: false`,
      `INTERACTIVE_RUNTIMES` (paid/remote AI infrastructure), link
      https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/
- [ ] Description must explicitly say partner models like
      `bytedance/seedance-2.0` do NOT appear in `itx.ai.models()` (classic
      `@cf/*` catalog only) but work directly via `itx.ai.run()` — that
      sentence is the docs-search discoverability fix
- [ ] Note in the example that `result.video` is a ByteDance-hosted signed
      URL that expires (~24h) — download/store to keep it
- [ ] Give the sibling `ai-generate-video` (grok) description the same
      one-line models()-under-reporting clarification (small tasteful edit)
- [ ] Regenerate `examples.generated.ts` (`pnpm generate:itx-examples`),
      AFTER `pnpm format`
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format` + relevant
      tests before pushing

### Model params (from Cloudflare docs)

`prompt` (≤2000 chars, required), `duration` 4–12s, `resolution`
480p/720p/1080p/4K, `aspect_ratio` 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 |
9:21; optional reference images (≤9), reference videos (≤3), audio files
(≤3), `seed`, watermark toggle, audio-generation flag.

## Implementation log

(nothing yet)
