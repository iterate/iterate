# Cloudflare deps: why `apps/os` is pinned to older versions

## TL;DR

`apps/os` is intentionally pinned to older Cloudflare tooling:

- `@cloudflare/vite-plugin: 1.15.3` (transitively pulls `miniflare@4.20251125.0`)
- `@cloudflare/workers-types: ^4.20251128.0`

Every other app (`apps/agents`, `apps/events`, `apps/codemode`, …) uses
`catalog:cloudflare`, pinned to the day‑20 release (`@cloudflare/vite-plugin
1.33.0`, `miniflare 4.20260420.0`, `workerd 1.20260420.1`, `wrangler 4.84.0`).
These versions are pinned exactly rather than as caret ranges because `pnpm`'s
`minimumReleaseAge: 1440` gate was silently dropping the day‑21 packages'
optional platform binaries from the lockfile, causing CI
`--frozen-lockfile` installs to fall back to stale `workerd` binaries and
fail with `Expected "2026-04-21" but got "workerd 2025-11-25"`.

`wrangler` is overridden repo-wide to `4.84.0` via `pnpm.overrides` so the
older `vite-plugin@1.15.3` can still parse the modern `wrangler.jsonc`
shape (`placement.region` without `placement.mode`).

## Why

Miniflare shipped two regressions between `4.20260205.0` (good) and
`4.20260420.0`+ (bad) that produce a V8 "JavaScript heap out of memory"
crash in the Node host process within 2–5 minutes of sustained traffic:

1. `DispatchFetchDispatcher.dispatch()` sets `options.reset = true` on every
   runtime request — this forces a brand‑new TCP connection per call
   instead of reusing the keep‑alive pool.
2. The `undici.Pool` constructor for the runtime dispatcher now passes
   `headersTimeout: 0, bodyTimeout: 0` — timeouts are fully disabled, so
   requests that stall or slow‑drain never release their buffers.

Put together, the `apps/os` dev server (which has a local cron simulator
firing `fetch(… /cdn-cgi/handler/scheduled)` every few seconds, plus normal
SSR traffic, plus concurrent Playwright specs) creates sockets faster than
it can free them. The Node host heap grows past the default ~1.4 GB limit
and V8 aborts. Bumping `--max-old-space-size` only delays the crash.

`apps/agents` does not trigger this — its e2e suite is a single WebSocket
turn against `events.iterate.com` with no cron loop — and it genuinely
needs `@cloudflare/vite-plugin ^1.33.x` for newer Node.js `require()`
interop used by its Workers AI + codemode flows. Hence the split.

## How the split works

1. `apps/os/package.json` pins the direct dep versions (no `catalog:` ref).
2. `pnpm-workspace.yaml` still defines `catalogs.cloudflare` at the latest
   versions for everyone else.
3. `package.json` → `pnpm.overrides` no longer forces a single
   `miniflare`/`workerd` across the repo. Each app's
   `@cloudflare/vite-plugin` brings its own transitive pair:
   - `apps/os` → `vite-plugin@1.15.3` → `miniflare@4.20251125.0` +
     `workerd@1.20251128.0`
   - `apps/agents`, others → `vite-plugin@1.33.0` → `miniflare@4.20260420.0` +
     `workerd@1.20260420.1`
4. `wrangler` stays overridden to `4.84.0` repo-wide so both plugins agree
   on the CLI/config format.

You can verify the split:

```bash
readlink apps/os/node_modules/@cloudflare/vite-plugin        # …vite-plugin@1.15.3…
readlink apps/agents/node_modules/@cloudflare/vite-plugin    # …vite-plugin@1.33.0…
```

## When to revisit

Delete this split once upstream Miniflare ships a fix for the two
regressions above (restores keep‑alive reuse and sane default timeouts on
the runtime dispatcher). At that point, flip `apps/os` back to
`catalog:cloudflare`, re‑add `miniflare`/`workerd` to `pnpm.overrides`, and
delete this doc.
