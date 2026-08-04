---
status: in-progress
size: medium
---

# "Miniflare OOM": diagnose the local dev-server death, stop living like this

## Status

Root cause identified from crash logs + upstream sources; empirical
reproduction and the dev.ts mitigation are in progress.

## The complaint

The local OS dev server dies after ~2-3 consecutive playwright spec runs
("Internal server error: fetch failed", health 500/000, playwright webServer
"exited early"). The working ritual is "restart the dev server before every
spec run", which is miserable. Figure out:

- [x] Do we have a smoking gun that it's really an OOM? _Yes —
      `worktrees/iterate/bump-middlewright-15/apps/os/.dev-server/dev-server.log`
      lines 2458-2459: `*** Received signal #6: Abort trap: 6` +
      `V8 fatal error; location = CALL_AND_RETRY_LAST; message = : allocation
      failed: JavaScript heap out of memory`. The `*** Received signal` prefix
      is workerd's crash handler; the GC trace shows the dying isolate was
      8ms old with a 1.9MB heap — a brand-new isolate that could not
      allocate, i.e. process-level exhaustion inside workerd, not a 4GB Node
      heap filling._
- [x] Is it an old version / fixed upstream? _No. workerd intentionally has
      no isolate eviction (maintainer: platform-level concern, "totally
      possible to implement your own LRU eviction on top of this codebase" —
      workerd discussion #351). All isolates in one workerd process share a
      ~4GB V8 pointer cage regardless of system RAM; when it's full, the next
      isolate creation aborts the process. Bumping wrangler/miniflare
      (4.107.0/4.20260701.0 → 4.118.0/4.20260730.0) does not change this._
- [x] Are we doing something wrong? _Sort of — by design.
      `apps/os/src/domains/workers/worker-loader.ts` keys `env.LOADER.get`
      with a `loaderInstanceNonce` that is unique per runner incarnation
      (per REQUEST for stateless ingress runners), because loader isolates
      capture runner-scoped loopback RPC bindings. Every script run / agent
      code round / project-worker request therefore mints an isolate under a
      never-reused key. In production Cloudflare's platform evicts cold
      isolates; local workerd keeps every one forever, so a long-lived dev
      server accumulates isolates until the pointer cage fills and workerd
      SIGABRTs._

## Remaining work

- [ ] Empirical smoking gun: fresh dev server, loop N script runs via the
      CLI, sample workerd RSS after each — capture the monotonic growth
      curve into this file
- [ ] Mitigation: `apps/os/scripts/dev.ts` learns the memory story —
      `status` reports workerd/node RSS, and resolving a "live" target
      auto-restarts the server when workerd RSS exceeds a threshold, so
      spec runs always start against a healthy server and the manual
      restart ritual dies
- [ ] Follow-ups documented: reduce isolate churn (reuse within runner
      lifetime), consider upstream ask (dispose/eviction hook for
      worker-loader in local workerd)

## Sources

- workerd discussion #351 ("Loading 100s of workers?") — no eviction by
  design, 4GB pointer cage shared across isolates
- Cloudflare Dynamic Workflows blog — production DOES evict loader isolates
  ("when the isolate eventually gets evicted, the next step.do() pulls the
  code again")
- Local crash log: `bump-middlewright-15/apps/os/.dev-server/dev-server.log`
