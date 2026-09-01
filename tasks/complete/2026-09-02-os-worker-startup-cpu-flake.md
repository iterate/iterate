---
status: done
size: small
---

# os worker startup CPU flake

**Status summary:** Done — PR #2561 fully green (all lanes including preview
deploy + e2e). zod 4.3.6 → 4.5.4 cuts measured startup CPU ~43% (GC ~76%);
three pieces of bump fallout found and fixed along the way (generator regex,
better-auth deviceAuthorization options, ZodError message loss over RPC).

## Problem

On [PR #2556](https://github.com/iterate-com/iterate/pull/2556) (mobile-only
changes), the Cloudflare preview deploy of apps/os failed 2 of 3 runs with
`Error: Script startup exceeded CPU time limit` from `wrangler deploy` —
Cloudflare validates a worker's global-scope execution against a 400ms CPU
limit at upload time. Succeeding on plain retry means main's startup cost
hovers near the limit and every deploy is a coin flip. Evidence: Depot CI runs
st82hhnwtw and dnz4tp5rd0 (org 0p91s0lz49), jobs k7ff0dgzpb and sglcxb8gt4.

## Checklist

- [x] Reproduce/measure startup CPU locally _`wrangler check startup` against
  the built dist (workerd, JIT-less like prod): ~115ms non-idle baseline —
  ~70ms JS work + ~31ms GC + ~10ms program. Profiles analyzed with a
  sourcemap-attribution script._
- [x] Identify heavy module-scope work _~52ms (+ most of the GC) was zod v4
  schema construction at module scope — processor contracts (~29ms), the itx
  surface / rpc-targets graph (~18ms), config schemas (~4ms). zod library init
  itself is only ~1.3ms. Stub experiments showed the DO-class exports alone
  cost ~97ms and the fetch path ~110ms — they share the same heavy core, so
  lazy-loading either side alone wins little._
- [x] Reduce startup CPU with margin _Bumped zod 4.3.6 → 4.5.4 everywhere
  (workspace + config templates). zod 4.5's construction/memory work ("9x
  reduction in schema memory footprint") cuts measured startup to ~66ms
  non-idle (~48ms work + ~7.5ms GC) — a 43% reduction, GC down 76%. No code
  restructuring needed._
- [x] Fix fallout _zod 4.5 prints its JSON type alias as `z.JsonValue`;
  extended the alias-rewrite regex in apps/os/scripts/generate-itx-api.ts so
  the generated itx api stays byte-identical. Regenerated
  config-repo-template.generated.ts (embeds template package.json with the
  new zod pin). Full monorepo tests, typecheck, lint, knip, format all pass._
- [x] Fix the auth worker startup crash the bump exposed _First CI round: the
  auth preview deploy died with an uncaught ZodError at global scope. zod ≥4.4
  rejects a missing object key for a non-optional `z.custom(...)` field
  (direct `.parse(undefined)` still passes — only the missing-key path
  changed), and better-auth 1.6.9's `deviceAuthorization` declares its
  `schema` option exactly that way and parses options at plugin construction.
  Passed `schema: {}` in apps/auth/src/server/auth-plugins.ts — a no-op for
  better-auth's mergeSchema — with a comment; upstream better-auth has already
  made the field optional, so the workaround dies with the next better-auth
  bump. Verified by constructing the real plugin against workspace zod, plus
  `wrangler check startup` on the built auth worker (~31ms non-idle, boots
  clean). Considered a unit test importing auth.schema-only.ts to pin worker
  global scope, but the plugin graph imports `cloudflare:workers`, which
  node --test can't load without mocking — the per-PR preview deploy is the
  real guard for this class, and it did catch it._
- [x] Fix ZodError message loss over Workers RPC _Once the (unrelated,
  repo-wide) Artifacts 403 was fixed by #2567 and merged in, preview e2e
  surfaced the bump's third landmine: zod 4.5 makes `ZodError.message` a lazy
  own accessor, leaving the Error's internal message slot empty — and
  structuredClone / Workers RPC serialize errors from internal slots, so a
  ZodError crossing a DO/RPC hop arrived as bare "ZodError" with no issues.
  Two e2e tests assert on validation messages and caught it; agents/API
  callers read those messages too, so it's a product regression. Fixed with
  a pnpm patch (patches/zod@4.5.4.patch) that materializes the message as an
  own data property at construction — zod ≤4.4 behavior, cost on failure
  paths only, startup re-measured unaffected. Not fixed upstream as of the
  latest canary; worth filing a zod issue._
- [x] CI green + review on the PR _Fully green 2026-09-02 after merging
  main (which brought #2567's fix for the unrelated repo-wide Artifacts 403
  that had been masking e2e). Deploys clean across every run: zero 10021s,
  which is this task's goal. No review threads at completion time; PR left
  as draft for Misha._

## Implementation notes

- Measurement loop: `doppler run --config dev -- pnpm exec vite build` (~10s)
  then `pnpm exec wrangler check startup --outfile x.cpuprofile` from apps/os
  (uses .wrangler/deploy/config.json redirect to dist/server). Non-idle time =
  total minus `(idle)` samples; note workerd runs JIT-less, which is why this
  is representative of Cloudflare's validator.
- Baseline failing ~2/3 at the 400ms limit with ~115ms local implies the
  validator machines are roughly 3.5x slower than an M-series laptop; ~66ms
  local ≈ ~230ms there, so margin is decent but not infinite. If flakes ever
  return, the next-biggest lever measured: remaining zod construction ~26ms
  (contracts + itx surface), then a flat long tail (sqlfu formatters, axios,
  jsonata, mcp client, crc-32 ~1-3ms each). Deferring the fetch path
  (tanstack handler, rpc-targets) alone saves only ~18ms because the DO
  exports pull the same graph.
- zod 4.4 contains intentionally-stricter correctness fixes (tuple defaults,
  coerce with missing keys). 3065 os tests + full workspace suites pass, so
  nothing in-repo depended on the old edge cases.
