# Stream benchmark harness — design discussion

Working doc. Captures decisions, open questions, hypotheses, experiment ideas,
and "crystal-clear insights we must not lose" as we grill through this.

## Locked-in decisions

These are confirmed by the user and not up for re-litigation here.

- Two distinct concepts: an **Experiment** (the parameterized recipe —
  TypeScript code) and a **Run** (one invocation of an experiment with
  concrete params, identified by `runId`). You "run an experiment" and get
  a Run object back.
- **Experiment registry shape (locked, option (a) below):** a shared package
  `packages/stream-bench-experiments/` with one folder per experiment.
  Each folder contains `manifest.ts` (slug, version, input/output Zod
  schemas, hypothesis), `run.ts` (the async function body), and `README.md`
  (human-readable motivation + hypothesis). A top-level `index.ts`
  re-exports manifests only; `index.runner.ts` re-exports manifests +
  run functions. Control plane bundles only manifests; the runner bundles
  the bodies too.
- **Experiments run in the cloud inside a Runner Durable Object.** Local
  execution is explicitly not required for now (revisit later). This unlocks
  long-running runs and lets us emit client-side measurements directly to
  Workers Analytics Engine from inside the worker runtime.
- An **experiment template is an arbitrary TypeScript function** invoked by the
  Runner DO. Full power to fan out, spawn child DOs, etc. — no fixed
  setup/run/teardown shape.
- **One Runner DO per run**, named by `runId`. The experiment template
  function runs inside that DO. If a run needs more concurrency or
  geographic spread, the Runner DO spawns child DOs of a separate class
  (working name **`LoadAgent`**) and orchestrates them via RPC. The Runner DO
  is the single source of truth for run state, progress, and cancellation.
- Working names: **`Experiment`** (the parameterized recipe / TS function),
  **`Run`** (one invocation, identified by `runId`), **`RunnerDO`** (one DO
  instance per run), **`LoadAgent`** (child DO the runner fans out to),
  **`Deployment`** (one separately-deployed worker — config + commit hash +
  service-binding name).
- There is a small **overlay D1 database** with tables for experiment
  templates, runs, streams under test, etc. The control plane is an **oRPC
  API** over this database. **trpc-cli** is the local interactive entrypoint
  to this oRPC API.
- Every deployed worker **bakes the git commit hash into the build**, and every
  run records the commit hashes of (a) the runner worker and (b) the
  deployment-under-test, plus the template id/version and input params, so
  runs are reproducible.
- **Three-worker topology**:
  1. **Stream worker(s)** — skinny workers that only host a `Stream` DO class
     (and whatever bindings that DO directly needs). Each stream version
     deploys as a worker; this _is_ the artifact under test, with its commit
     hash baked into the build.
  2. **Control plane worker** — full app: D1 overlay, oRPC API, Vite-style UI
     for inspecting runs, dispatching new ones, and visualizing results.
     trpc-cli targets this worker's oRPC.
  3. **Benchmark runner worker** — hosts `RunnerDO` and `LoadAgent` DOs.
     Receives jobs from the control plane (probably via service binding RPC)
     and executes the experiment template code. Talks to stream worker(s) via
     **static service bindings** (one binding per logical deployment target —
     dispatch namespaces don't work for RPC) and/or public HTTP/WS, depending
     on what the experiment is measuring.
- A **`Deployment`** = one separately-deployed worker. Multiple workers may
  share Stream DO source code but differ in compatibility flags, binding
  shape, hibernation settings, or entrypoint shape; each is its own
  deployment row.
- Deployments must be runnable both **against miniflare** (local) and against
  **deployed Cloudflare workers**.
- **Don't overwrite the stream DO.** Multiple versions live side-by-side under
  `src/stream/vN/` (already true for `v0`).
- Each deployment owns one or more `wrangler.json` files and worker entrypoint.
- Metrics go into **Cloudflare Workers Analytics Engine** (ClickHouse). Results
  must be queryable and visualizable. Cross-reference with CF Workers
  Logs/Observability.
- **Latency target = event-delivery latency**: commit → subscriber observed.
  Append ack latency and processor follow-up append latency are supporting
  surfaces but not the headline target.
- **No per-event WS round-trips for cursor/offset tracking.** Server-push
  dominates; cursor advancement is a separate, slow, out-of-band process.

## Persistence ownership

- **D1 lives only in the control plane worker.** Schema is owned in one
  place and the runner does not bind D1. All D1 writes flow through the
  control plane.
- The control plane worker exposes its **`WorkerEntrypoint` RPC methods**
  (e.g. `transitionRun`, `appendNote`, `listExperiments`) that the runner
  service-binds and calls. Wrangler now generates correct TS types for these
  RPC surfaces.
- **Runner DO SQLite** holds per-run live state: progress messages,
  intermediate counters, current phase. Dies with the run; not the
  system-of-record.
- **Workers Analytics Engine** receives one row per quantitative metric
  event, tagged with `runId` + `experimentSlug` + dimension blobs. Schema
  to be designed (next question).
- **Workers Logs (Observability)** receives structured `console.log` JSON
  trail tagged with `runId` for qualitative cross-reference.

(D1 schema sketch — `experiments`, `deployments`, `runs`, `notes` — is in the
"Decision log" section once locked.)

## Experiment function contract (v1)

An Experiment is an `async function run(ctx, params)` invoked by the Runner DO
in **a single async call** — no alarm-driven checkpointing in v1. If we ever
need a run longer than CF's DO request wall-time budget, we'll introduce
checkpointing for the longest experiments only.

The `ctx` surface:

```ts
type ExperimentCtx = {
  runId: string;
  // Typed handle to a deployment. Exposes both RPC and HTTP/WS surfaces so
  // the experiment chooses the dispatch shape it's testing.
  deployment(id: string): { rpc: StreamWorkerEntrypoint; httpBaseUrl: string };
  // Fan out to child DOs for concurrency / geographic spread.
  spawnLoadAgents(args: { count: number; locationHint?: LocationHint }): Promise<LoadAgentHandle[]>;
  // Emit a metric row to Workers Analytics Engine. runId + experimentSlug
  // auto-tagged — the experiment only supplies the per-event payload.
  metric(args: { name: string; value: number; tags?: Record<string, string> }): void;
  // Human-readable progress (persisted to Runner DO storage; UI tails it).
  progress(args: { status: string; details?: Record<string, unknown> }): void;
  // Cancellation. Tripped by the control plane via `runs.cancel`.
  signal: AbortSignal;
};
```

Things deliberately not in v1: no D1 access from experiments (they're pure-ish:
emit metrics, return summary; the runner persists), no enumeration of
deployments (every experiment names the deployments it uses explicitly), no
helper for sleeping / waiting (just use `scheduler.wait` / `setTimeout` /
`Promise` directly).

## Crystal-clear insights we must not forget

> One-line truths that are clear to the user right now. Save them so we don't
> have to re-derive them.

- We cannot bounce back and forth between two peers of a WebSocket for every
  event when streams carry thousands of events per second. Cursor / offset
  advancement happens in a separate, slow process, not synchronously per event.
- `Date.now()` / `performance.now()` are frozen during synchronous CPU on a
  deployed Worker (Spectre mitigation). CPU-bound benchmarks must be measured
  at the client, or only across awaited I/O.
- Durable Objects can drift behind real time under load — same-turn timestamps
  may be identical, so `offset` is the only reliable ordering key.
- **Dispatch Namespaces (Workers for Platforms) only expose `fetch()`**, not
  arbitrary `WorkerEntrypoint` RPC. Because experiments must be able to test
  the RPC dispatch path explicitly (named entrypoints are one of the things
  we want to measure), the runner uses **static service bindings** to stream
  workers, even though that means amending the runner's `wrangler.json` each
  time we add a new deployment target. That's the price; it's worth it.

## Brainstorm: experiment ideas to investigate

> Just dump them here as we think of them so we don't lose them. Promote to
> formal experiment docs later.

- Max append throughput of a single stream DO.
- Impact of (re)deploying the worker mid-run on in-flight subscribers and
  appends.
- Cost of named **WorkerEntrypoint** / capability bindings vs `env.X.fetch(...)`
  vs in-process calls.
- Splitting the worker into smaller scripts vs one fat worker — perceived
  latency, cold start, bundling cost.
- WebSocket Hibernation API vs a non-hibernating WS path under high event rate
  (does hibernation hurt the live push path?).
- Append batch size sweep (1, 10, 100, 1000, 10000) — throughput vs ack latency.
- Subscriber count sweep on one DO — per-event fanout cost.
- One DO with N subscribers vs N DOs with 1 subscriber each.
- DO storage SQL `INSERT` strategies: per-row, prepared statement, multi-row
  values, transaction batches.
- Effect of `idempotencyKey` index lookups on append throughput.
- Reading historical range while live appends are flowing — does read starve
  the live path?
- Effect of payload size (100B, 1KB, 10KB, 100KB) on throughput and latency.
- Geographic latency: client in EU vs DO colo in US.
- Cold start cost: first append after long idle vs warm append.
- Append from another worker (RPC) vs append from outside (HTTP/WS).
- Append from a processor DO that itself subscribes to the stream (the
  "feedback loop" shape).
- Burst tolerance: pin 1M events into a queue, then unblock; how does the
  subscriber lag curve look?
- Effect of `nodejs_compat` flag on cold start and steady-state throughput.
- Effect of advancing `compatibility_date` (do new runtime semantics change
  any of the numbers?).
- Two clients appending concurrently into one stream — contention curve,
  SQLite WAL behavior under writes.
- Append latency during background SQL maintenance (vacuum-equivalent),
  if any.
- Subscriber catch-up: replay latency vs backlog depth (10k, 100k, 1M
  events behind).
- Backpressure: what does the DO do when a subscriber can't drain as
  fast as commits happen? Does it buffer, drop, kick the subscriber?
- Number of concurrent subscribers per DO before memory eviction kicks in.
- DO eviction recovery: time to rehydrate from SQLite after eviction,
  measured by first append after a long idle.
- Effect of `Date.now()` clock drift on append `createdAt` ordering under
  burst load (a sanity-check experiment, not a perf experiment).
- Throughput when the runner and the stream DO are colocated vs in
  different colos (`LocationHint` sweep).
- Throughput when subscribers are spread across colos vs all in one colo.
- WebSocket framing: NDJSON vs MessagePack vs CBOR for event payloads —
  CPU cost on DO commit + bandwidth.
- `appendBatch(N)` vs `N × append()` for the same total throughput —
  does batching reduce DO storage SQL turn count?
- Effect of `idempotencyKey` cache size on append throughput (cold lookup
  vs warm lookup under high churn).
- Latency of `read(after=X)` vs `subscribe(after=end)` (cursor lookup cost).
- `getByName(name)` vs `getByName(idFromName(name))` — does the name→id
  resolution add measurable latency at the call site?
- How many fresh DO instances can be created per second from one runner
  worker (rate-limiting boundary).
- TLS handshake cost on each new WS connection vs reusing a connection
  for many ops.
- Cost of running a sqlfu migration on a populated DO at startup.
- Migration time: how long does adding a column take on a DO with 1M
  rows? Does the DO go offline during it?
- "Processor" feedback loop: a processor DO subscribes to a stream and
  appends derived events back into the same stream — does it deadlock?
  (We have a `websocket-processor-deadlock-example.md` already.)
- Aggregator DO: subscribes to N streams, emits to 1 consolidated stream.
  Does the consolidator become a bottleneck before any individual stream
  does?
- Effect of WS Hibernation autoresponse keepalives on the live-push path.
- Cost of split-worker entrypoint (named WorkerEntrypoint per role) vs
  one fat entrypoint that dispatches internally.
- Service binding RPC vs WS vs HTTP fetch for the same operation —
  apples-to-apples latency comparison.
- The "minimal hop" baseline: in-process call (Stream DO + runner in same
  worker) vs cross-worker service binding vs public HTTP/WS.
- Catch-up + live-push concurrency: subscriber reading historical range
  while live-push events are flowing — does read starve live, or vice
  versa?
- Effect of payload validation (Zod parse) on commit latency.

## Open questions / things being grilled

> Updated live as the interview progresses.

(See discussion below.)

## Decision log

> Append-only. Each entry: date, question, decision, reasoning.

(Empty.)
