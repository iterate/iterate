# Investigation: why native facet-method RPC works in apps/os but throws in the clean room

**Symptom.** Calling a custom RPC method on a Durable Object _facet_ whose class was
loaded through the Worker Loader —

```ts
const worker = env.LOADER.get(key, () => ({ …, modules }));
const klass  = worker.getDurableObjectClass("Actor");
const facet  = ctx.facets.get("target", () => ({ class: klass }));
await facet.ping(2);           // ← throws in the clean room
```

throws **`"Durable Object Facet stubs cannot be transferred between Workers."`** in the
clean-room `apps/project-worker`, but the _identical_ pattern in `apps/os`
(`StatefulWorkerDurableObject` → `replayPath` → `target.method()`) **works in
production** (verified 2026-08-04 on os.iterate.com). The facet **fetch** lane
(`facet.fetch(req)` → Response by value) works everywhere; only the **method** call fails.

Goal: find the single config/code difference, get native method RPC working in the clean
room, and note everything learned along the way.

## Ruled out

- **Account entitlement.** apps/os runs on the prod account `04b3…` _and_ the
  preview/dev account `376ef…` and native facet RPC works on both. The clean-room
  `project-worker` also deploys to `04b3…` (same account as apps/os prod). Same account,
  different result ⇒ **not** an account-level Worker-Loader/facet entitlement. (Confirmed by
  the user: "apps/os works in both preview and prd accounts — this is a red herring.")

- **`rpc_params_dup_stubs` compat flag.** The flag "duplicate stubs in RPC params instead
  of transferring ownership" (`rpc_params_dup_stubs` / disable `rpc_params_transfer_stubs`)
  is **default-on since compat date 2026-01-20**. Both apps/os (loaded 2026-05-01, supervisor
  2026-07-01) and the clean room (both 2026-07-01) are past that date, so both already have it.
  Not the discriminator. (It governs stubs embedded in _params_; the facet error is a
  separate hard guard.)

## Config deltas found between apps/os and the clean room

| Layer                                  | apps/os                                             | clean-room project-worker |
| -------------------------------------- | --------------------------------------------------- | ------------------------- |
| **Loaded (facet) worker** compat date  | `2026-05-01` (`WORKER_COMPATIBILITY_DATE`)          | `2026-07-01`              |
| **Loaded (facet) worker** compat flags | `["nodejs_compat"]` (`WORKER_COMPATIBILITY_FLAGS`)  | _(none)_                  |
| **Supervisor** worker compat date      | `2026-07-01` (`COMPATIBILITY_DATE`)                 | `2026-07-01`              |
| **Supervisor** worker compat flags     | `["nodejs_compat", "global_fetch_strictly_public"]` | _(none)_                  |
| loaded-worker `env`                    | scoped `ITX` loopback + `ITERATE_WORKER_VERSION`    | `{}`                      |
| loaded-worker `globalOutbound`         | project egress fetcher                              | _(none)_                  |

Sources: `apps/os/src/domains/workers/build-backend.ts` (loaded compat),
`apps/os/scripts/generate-wrangler-config.ts:571-578` (supervisor compat),
`apps/os/src/domains/workers/worker-loader.ts:223-231` (`loadResolvedWorker`),
`apps/os/src/domains/workers/stateful-worker-durable-object.ts:236` (`ctx.facets.get`),
`apps/os/src/domains/capability-host/live-capability.ts:73-101` (`replayPath`).

## Method

Standalone throwaway worker `facet-lab` (NOT in the repo — lives in the session scratchpad)
deployed to account `04b3…`. Supervisor matches apps/os exactly
(`2026-07-01` + `nodejs_compat` + `global_fetch_strictly_public`). It loads an `Actor` DO
class as a facet and offers `/native` (method call) and `/fetch` (control) lanes, with the
**loaded worker's** compat date + flags selectable by query string so one deploy sweeps the
whole matrix. Bisect from the faithful apps/os repro toward the clean-room config.

## RESOLVED — root cause + fix (2026-08-05)

**The tunnel is gone; native facet-method RPC works.** Root cause was neither the account, compat,
stale isolates, nor topology — it was the **reflection idiom used to invoke the method**.

- **Bug:** the invoke did `const fn = facet[method]; fn.apply(facet, args)`. On a Worker-Loader facet,
  `facet[method]` is an RPC **stub method proxy**; reading `.apply` off it is treated by capnweb as a
  _pipelined remote path_, and calling it with the facet stub as `thisArg`/arg makes workerd **serialize
  the facet stub** as an RPC value. A dynamically-loaded facet stub may NEVER be serialized —
  workerd's `requireAllowsTransfer()` throws unconditionally for dynamic entrypoints
  (`server.c++` `throwDynamicEntrypointTransferError`; the message is paraphrased as _"Durable Object
  Facet stubs cannot be transferred between Workers"_, surfaced as a **`DataCloneError`**).
- **Fix:** invoke exactly like apps/os `replayPath` — `Reflect.apply(Reflect.get(facet, method), facet, args)`.
  `Reflect.apply` invokes the function's `[[Call]]` directly; the stub is never read-for-`.apply` and never
  serialized. A method call executed **inside the owning DO** returns plain data, so the stub never crosses
  a Worker boundary. (`facet-lab` worked because it used a _direct_ `facet.ping(2)` call, not `.apply`.)
- **Why the fetch tunnel "worked":** a `Response` passes **by value**, so `facet.fetch()` never serialized
  the stub. It was a correct-but-unnecessary by-value workaround. Removed.

Proven on `project-worker.iterate.workers.dev` (deployed, native-only, no tunnel/no wrapper): `itx.counter`
increment 2/5/10, value 10, `/facet` fetch lane, durability across a source-change facet restart AND across
a parent redeploy on the same ctx (value 10 → increment(5) → 15). Diagnostic proof: on the SAME deployment,
`fn.apply` logged `NATIVE_FAIL … DataCloneError` while `Reflect.apply` logged `NATIVE_OK`.

**Also fixed (a real latent bug, independently flagged from workerd source):** the loader cacheKey now
folds in `CF_VERSION_METADATA.id` (a `version_metadata` binding), so a redeploy mints a fresh loaded
isolate — mirroring apps/os, which documents that a loaded isolate must not survive a parent rollout. This
was NOT the native-RPC cause (a fresh ctx on the versioned build still threw with `fn.apply`), but it's the
correct apps/os mirror and prevents a stale-isolate transfer error across rollouts.

**Correction to earlier record:** the previous conclusion ("most likely an account-level Worker-Loader
entitlement on the POC account vs iterate prod") was WRONG. Same account, same everything — the difference
was the `.apply`-on-stub idiom in the clean room's own code.

## Log

### Round 1 — `facet-lab` standalone worker (account 04b3). The mechanism WORKS.

Deployed `facet-lab.iterate.workers.dev` (scratchpad, throwaway). It loads an `Actor` DO class
as a facet and offers `/native` (`await facet.ping(2)`) and `/fetch` control lanes, sweeping the
loaded-worker compat + wrapper + DO-hop count. **Native facet-method RPC returned `{pong:20}` in
EVERY configuration tested:**

| variant                                                                                                        | result   |
| -------------------------------------------------------------------------------------------------------------- | -------- |
| loaded `2026-05-01`+`nodejs_compat` (apps/os cfg), 1 hop                                                       | native ✓ |
| loaded `2026-07-01`+no flags (**clean-room cfg**), 1 hop                                                       | native ✓ |
| clean-room cfg, **2 DO hops** (Gateway→Host→facet)                                                             | native ✓ |
| clean-room cfg, **two-module `__HostedActor extends Actor`** wrapper (faithful `statefulDoRunner`), 1 & 2 hops | native ✓ |
| **supervisor with NO compat flags** (= project-worker), all loaded cfgs                                        | native ✓ |

⇒ **Ruled out** as the discriminator: account, loaded-worker compat date/flags, supervisor compat
flags, DO-hop count (1 vs 2), and the `__HostedActor` wrapper shape. The apps/os mechanism is
provably portable to this account. So the trigger is **something specific to `project-worker`**
that `facet-lab` does not replicate.

### Leads under investigation (what facet-lab does NOT replicate)

1. **Loader cacheKey omits the parent-deployment version.** Clean-room key =
   `stateful:${ctx.id.name}:${sourceHash}`; apps/os deliberately includes `env.WORKER_SELF` +
   `workerVersion(env)` so a loaded isolate can't survive a parent rollout (`worker-loader.ts`
   comment: loader isolates capture the parent deployment's loopback bindings). A stale isolate
   reused after redeploy could make a cross-parent call illegal — and `project-worker` has been
   redeployed many times against the same source hash, unlike freshly-deployed facet-lab.
2. **Loaded-worker `env`/`globalOutbound`.** apps/os passes `env:{ITX: ctx.exports.ItxEntrypoint({props})}`
   - `globalOutbound`; clean-room passes `env:{}`. (Note: apps/os passing MORE stubs still works, so
     absence isn't obviously the cause — but the stub is minted from the OWNING DO's `ctx.exports`.)
3. **capnweb return path.** The itx tree is served over capnweb; facet-lab uses plain fetch→DO-RPC→JSON.

Direct in-worker test (`native-probe-1`, native-first + tunnel-fallback + `NATIVE_OK`/`NATIVE_FAIL`
logging) was deployed to `project-worker` but the runner-DO code had not yet propagated when the run
was paused (DO code lags the fetch handler ~1 min; no NATIVE marker seen yet — that run still used the
old pure-tunnel DO code, hence correct counter values with no probe logs). Two background agents are
generating ranked hypotheses; tests to be run single-threaded to avoid deploy collisions.
