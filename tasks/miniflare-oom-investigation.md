---
status: implemented
size: medium
---

# "Miniflare OOM": diagnose the local dev-server death, stop living like this

## Status

Done: root cause pinned with a smoking gun + live reproduction, and dev.ts
now auto-restarts a memory-pressured server so the manual ritual dies.
PR: https://github.com/iterate/iterate/pull/2401

## The complaint

The local OS dev server dies after a few playwright spec runs ("Internal
server error: fetch failed", health 500/000, playwright webServer "exited
early"). The working ritual was "restart the dev server before every spec
run".

## Findings

- [x] Smoking gun that it's really an OOM _Two of them. (1) Crash log
      (`bump-middlewright-15/apps/os/.dev-server/dev-server.log:2458`):
      `*** Received signal #6` (workerd's crash-handler prefix) +
      `V8 fatal error; CALL_AND_RETRY_LAST; allocation failed: JavaScript
      heap out of memory`, with a GC trace showing the dying isolate was 8ms
      old holding 1.9MB — a brand-new isolate that couldn't allocate, i.e.
      process-level exhaustion inside workerd, not a Node heap filling.
      (2) Live: the worktree that ran ~7 spec runs that morning had its
      workerd at 2.88GB RSS while every idle worktree's workerd sat at
      5-50MB._
- [x] Old version / fixed upstream? _No. workerd intentionally ships no
      isolate eviction (maintainer position in workerd discussion #351:
      platform-level concern; "totally possible to implement your own LRU
      eviction on top of this codebase"). All isolates in one workerd
      process share a ~4GB V8 pointer cage regardless of system RAM; when
      it fills, the next isolate allocation SIGABRTs the process. Cloudflare
      production evicts cold loader isolates platform-side (Dynamic
      Workflows blog confirms), so this is a LOCAL-ONLY hazard. Bumping
      wrangler/miniflare (we're on 4.107.0/4.20260701.0; latest
      4.118.0/4.20260730.0) doesn't change it._
- [x] Are we doing something wrong? _Not per-script, per measurement. The
      loader key in `apps/os/src/domains/workers/worker-loader.ts` includes
      a per-runner-incarnation nonce, but measured isolate cost is tiny for
      script runs. The accumulator is PROJECT WORKERS (seeded docs-app
      bundles etc.): the server's first project cost ~1GB workerd RSS, each
      further fresh project +66-134MB, and every project-worker rebuild
      (content change → new cache key) adds a fresh big isolate. Nothing is
      ever freed, so RSS is monotonic until the cage fills. Spec runs create
      fresh projects every run — hence death after a handful of runs._

### Measurements (fresh dev server, `pnpm cli itx run` loop, workerd RSS)

| probe | result |
| --- | --- |
| first-ever script run in a fresh project | 120MB → 1196MB (+~1GB: project worker bootstrap) |
| 25 identical script runs | +~50KB/run (same loader key → isolate reused) |
| 15 unique-content script runs | +~53KB/run (script isolates are near-free) |
| 2 further fresh projects | +66MB, +134MB |
| idle/any amount of waiting | never shrinks below the ~1.1GB floor |

## Fix (this PR)

- [x] `pnpm dev status` reports `workerdRssMb` — the crash predictor is now
      visible _formatStatus sums RSS of the vite pid's workerd descendants_
- [x] Auto-restart on memory pressure: `start` and
      `localOsDevServer.resolveTarget` (used by playwright's webServer)
      treat a live server whose workerd RSS exceeds
      `ITERATE_DEV_WORKERD_RSS_LIMIT_MB` (default 2048) as already dead —
      kill it and hand back a fresh-start target on the same port. Verified
      live: with limit 500 a 1360MB server was killed and
      `{kind: "start", port: same}` returned._

## Follow-ups (not this PR)

- Project-worker isolate reuse/teardown: erasing or aging out dead spec
  projects' workers locally would flatten the biggest accumulator
- Upstream ask: an opt-in eviction/dispose hook for worker-loader isolates
  in local workerd (they explicitly invite building eviction on top)
- Consider a periodic RSS log line from the vite plugin so growth is visible
  in dev-server.log without running `pnpm dev status`

## Sources

- workerd discussion #351 ("Loading 100s of workers?") — no eviction by
  design; ~4GB shared V8 pointer cage
- Cloudflare Dynamic Workflows blog — production evicts loader isolates
- Crash log: `bump-middlewright-15/apps/os/.dev-server/dev-server.log:2458`
- Probe data: 42 CLI script runs against a fresh dev server, 2026-08-04
