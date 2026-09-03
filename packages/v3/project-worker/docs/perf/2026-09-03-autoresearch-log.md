# Performance autoresearch log — clean room (`packages/v3/project-worker`)

Started 2026-09-03. Goal (Jonas, AFK): optimise boot time, latency, throughput, CPU time and memory of
the clean-room implementation in an autoresearch loop — measure, hypothesise, change, re-measure, keep
or revert. Rules: no capability drops; LOC may grow at most 10 % and only for very meaningful gains;
NEVER make existing events ephemeral (`stream/woken` stays durable — most events will come from other
providers later); every proof and every number that counts is taken against the DEPLOYED worker
(`https://project-worker.iterate.workers.dev`), local workerd numbers are marked LOCAL; commit and push
each kept step. Bigger learnings and capability-dropping suggestions go to
`docs/perf/learnings-and-bigger-refactors.md`.

Every entry: what was measured (how, where), the hypothesis, the change, the numbers before/after,
KEPT or REVERTED, the commit.

## 0. Deploy and prove the clean room as it stands (prerequisite)

- `pnpm deploy` refused: the pre-rename class `StreamDurableObject` still had a provisioned namespace
  on workers.dev (an orphan). Retired with a `deleted` tombstone in `wrangler.jsonc` `exports`; the
  namespace `IterateContextDurableObject` was created fresh. Deployed version `41d795aa`.
  Wrangler's "Worker Startup Time: 17 ms" is the first boot number (the script's top-level evaluation
  at upload, measured by Cloudflare).
- Added DEPLOYED-TARGET MODE to the e2e lane: `WORKER_BASE_URL=<url> pnpm e2e` runs the same suite
  against the deployed worker with no local boot (`e2e/support/global-setup.ts`);
  `workers-remote-capnweb.e2e` skips unless `DUMMY_CAPNWEB_URL` names a public dummy.
- PROVED against the deployed worker (`WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e`):
  37 files passed, 1 skipped (workers-remote-capnweb: no public dummy), 145 tests passed, 2 expected
  fail, 2 skipped; 26.7 s wall on the laptop against the edge. Local workerd for the same suite:
  147 passed, 2 expected fail. The clean room as it stands works on Cloudflare.
- Cloudflare MCP: the OAuth flow needs a browser; the Chrome extension is not connected in this
  session, so observability is read through the Workers Observability API with wrangler's token
  (same data the MCP wraps). The MCP login URL is in the session transcript for Jonas to complete.

## 1. The harness (`pnpm bench`) and the baselines

`bench/api.bench.ts` on vitest's benchmark runner (tinybench), over the e2e client (capnweb at /api;
FETCH LANE scenarios go one HTTP request per call so the deployed worker's tail attributes cpuTime /
wallTime per call — `bench/tail-summary.ts` summarises a `wrangler tail --format json` capture by
lane). `WORKER_BASE_URL=<url>` targets the deployed worker; `BENCH_OUT=<json>` keeps the samples.
Scenarios: boot (fresh context's first call vs the warm round trip beneath it), latency (durable /
ephemeral append, read 100, a one-rule chain onto kv, core snapshot), throughput (100 pipelined
appends, one 100-event append, 100 ephemerals), delivery (append → lent callback push; append →
processor reduced; warm facet snapshot), facet cold start (fresh context: enableProcessor + first
waitUntilProcessed).

LOC baseline for the 10 % rule: `src` non-test, non-generated = 6,512 lines (4,044 code lines); the
ceiling is 7,163.

### LOCAL baseline (workerd on the laptop, `BENCH_TIME_MS=1500`) — for iteration only

| scenario                                            | mean ms            | p99 ms |
| --------------------------------------------------- | ------------------ | ------ |
| boot: fresh context, first whoami (warm session)    | 1.69               | 4.6    |
| boot: warm context, whoami                          | 0.31               | 0.8    |
| boot: FETCH LANE fresh context whoami               | 2.72               | 13.0   |
| boot: FETCH LANE warm context whoami                | 1.01               | 3.3    |
| latency: durable append, 1 event                    | 0.48               | 2.7    |
| latency: ephemeral append, 1 event                  | 0.43               | 4.0    |
| latency: read 100                                   | 0.54               | 4.2    |
| latency: kv.get through a rewrite rule              | 0.57               | 5.2    |
| latency: core snapshot                              | 0.32               | 2.1    |
| latency: FETCH LANE durable append                  | 1.22               | 3.9    |
| throughput: 100 pipelined single appends            | 53.9 (≈1,860 ev/s) | 275    |
| throughput: 1 append of 100 events                  | 4.78 (≈21k ev/s)   | 12.6   |
| throughput: 100 ephemeral appends in flight         | 31.9               | 40     |
| delivery: append → lent callback push               | 0.59               | 2.5    |
| delivery: append → processor reduced                | 1.68               | 5.4    |
| delivery: warm facet snapshot                       | 0.52               | 4.6    |
| facet cold start (fresh ctx, enable + first reduce) | 27.3               | 31     |

First reading (local): a DO boot is ≈1.4 ms over the warm round trip; a pipelined single append
costs ≈0.54 ms of DO time each (the commits serialise), an ephemeral ≈0.32 ms — the PER-CALL
overhead (capnweb frame → edge → RPC → dispatch) is ~0.3 ms and dominates every small call; batching
100 events into one append is 11× cheaper per event than pipelining 100 appends. A facet cold start
is 27 ms (loader + class + first call + catch-up).

### DEPLOYED baseline (workers.dev from the laptop, `BENCH_TIME_MS=5000`) — the numbers that count

Client-perceived mean ms (laptop → edge; network RTT ~13–17 ms is the floor), with the deployed
worker's own tail cpuTime beside it (p50 unless noted):

| scenario                                     | client mean ms               | DO/edge cpu p50 ms |
| -------------------------------------------- | ---------------------------- | ------------------ |
| boot: fresh context, first whoami            | 488 (n=13, ±42%)             | —                  |
| boot: warm context, whoami                   | 16.9                         | edge 0 / DO 0      |
| boot: FETCH LANE fresh context whoami        | 396                          | —                  |
| boot: FETCH LANE warm context whoami         | 36.9                         | —                  |
| latency: durable append, 1 event             | 27.1                         | DO 0–1             |
| latency: ephemeral append, 1 event           | 17.5                         | —                  |
| latency: read 100                            | 18.0                         | —                  |
| latency: kv.get through a rewrite rule       | 22.8                         | —                  |
| latency: core snapshot                       | 17.6                         | —                  |
| latency: FETCH LANE durable append           | 32.5                         | edge 0 / DO ≤1     |
| throughput: 1 append of 100 events (batched) | 34.8 (≈2,900 ev/s wire)      | —                  |
| throughput: 100 pipelined single appends     | 121 THEN **the run aborted** | —                  |

Tail (4,018 events over the run): `durableObject rpc:invoke` cpuTime p50 **0 ms**, p95 0, wall p50
33 ms; every lane's cpuTime p50 is 0 and p95 ≤ 5 ms. **CPU is not the bottleneck at these fixture
sizes — wall time is network RTT + the DO's own I/O.** The one number with real signal: a durable
append is ~27 ms vs an ephemeral ~17 ms — ~10 ms for the SQLite row + the full-core-state checkpoint
put, on the edge, on the client's critical path. First cold boot of a context is ~490 ms (a genuine
DO cold start; n is tiny and noisy).

### Finding F-subreq (→ learnings): 100 appends pipelined over ONE session abort with "Too many API

requests by single Worker invocation"

The `100 single-event appends in flight` scenario aborted the whole bench with `Too many API requests
by single Worker invocation` (Cloudflare's per-invocation subrequest cap, 1,000 by default). 100
concurrent `itx.invoke(["itx",["append",…]])` over one capnweb WS become 100 stateless→DO Workers-RPC
subrequests attributed to ONE stateless invocation. This is the deployed confirmation of the review's
measure-next #1 (the 10,000-delivery wall apps/os hit) at the APPEND door, and it bounds how hard a
single client can hammer one session before it must either batch (one append of N events — 34.8 ms
for 100, and it is ONE subrequest) or reconnect. Not a regression; a real ceiling. Detail and options
in learnings.

## 2. Two CPU no-brainers on the dispatch and facet-push paths (L4, L1a)

Both capability-neutral, behaviour-identical, pinned by the existing unit suites.

- **L4 — a built-in-rooted dispatch no longer materializes the rewrite-rules table.**
  `rewriteItxExpressionToBuiltIn` now takes the rules THUNK and reads it at most once, and NOT AT ALL
  when the call is already built-in-rooted (`itx.append`, `itx.read`, `itx.kv.*`, and every
  facet-push target `itx.facets.get(...)` — no rule can apply to a built-in root). Before, the DO
  thunk `() => Object.values(coreReducedState.itxExpressionRewriteRules)` was invoked as an argument
  on EVERY dispatch, building and dropping the array even when the root short-circuits before the
  rule loop. `itx-expression-rewriting.ts`; the resolver passes `this.#rewriteRules` (the field is
  already a thunk); one table-test call site. Gain: −1 `Object.values(rules)` allocation per dispatch
  for every built-in call — ~0 at small rule counts, 5 µs/dispatch at R=100, 63 µs at R=1000; the
  point is the hot path stops allocating a table it will not read.
- **L1a — a warm facet push no longer re-hashes its source.** The literal-module content hash (djb2,
  ≈7 µs per KB) is memoized in a `WeakMap<WorkerModules, string>` keyed on the source object. A push
  evaluates `itx.facets.get(name, spec).processEventBatch` with the SAME `spec.source` object every
  commit (the row's parsed target in core state, stable across pushes within an incarnation), so the
  per-character loop runs once per source per incarnation, not once per push. `worker-loader.ts`.
  Gain: ≈7 µs/KB/push of literal-module source off the DO thread (and off the producer's append RTT
  in workerd, where the review measured this on the critical path) — ~0.25 ms/push at 40 KB, ~2 ms at
  330 KB; zero for `cacheKey` producer sources. Unmeasurable at the 0.3–0.7 KB fixtures (cpuTime p50
  is already 0 on the tail), so proven by construction + the unchanged loaderId assertions, not by a
  fixture number; it removes an O(source) loop from the per-push path.

LOC: +18 net (worker-loader memo helper + comments), well inside the 10 % ceiling.

### Deployed proof of L4+L1a

Full deployed e2e after L4+L1a: 36 files passed, 1 skipped, 144 passed, 2 expected fail, and ONE
failure — `rpc-stubs-slack-bridge.e2e` ("a live bridge replays the natural dotted spelling onto the
SDK end to end"). Re-run ALONE against the deployed worker it passes 3/3, and the local full lane is
147/2xf. So it is a timing-sensitive live-bridge test flaking under 144 parallel tests hammering one
edge worker plus network jitter, not an L4/L1a regression (the rules-thunk and hash-memo paths are
behaviour-identical and unit-pinned). Script upload after both changes: 1,225.86 KiB (was 1,480.38
before W2), startup 19 ms.

## 3. Investigated, NOT a problem: the facet→parent loopback and the 49 CANCELED ItxEntrypoint invocations

The tail showed 49 `stateless ItxEntrypoint` invocations with outcome `canceled`, ~63 ms wall, 0
cpuTime, during the e2e run. Traced: a facet's engine sink is
`append: (...events) => this.env.ITX.get().append(...events)`
(`src/sdk/stream-processor-durable-object.ts`), and the live-state delta rides it fire-and-forget
(`src/stream/live-state.ts` `set` → `void Promise.resolve(sink.append(...)).catch(...)`). When the
parent request that triggered the push finishes first, the fire-and-forget loopback append is
canceled. This is HARMLESS and by contract: 0 cpuTime (nothing billed), and a dropped live-state
delta is a revision-chain gap the client re-seeds (lossy by design). `env.ITX.get().append(...)` is
already ONE round trip — Workers-RPC pipelines `.append` onto the unresolved `.get()` promise (the
dispatch pipelining doctrine), so there is no extra hop to remove. Making the parent `waitUntil` the
delta would only PIN the DO against hibernation for a delta that is allowed to drop. So: left as is.
The real lever here is T2 (emit fewer deltas under many changing processors) — a semantics change,
on the menu, not the loop.
