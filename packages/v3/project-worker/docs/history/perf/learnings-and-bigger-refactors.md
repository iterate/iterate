# Performance — larger learnings, bigger refactors, and capability-dropping options

Companion to `2026-09-03-autoresearch-log.md`. Everything here is OUTSIDE the loop's rules (a
capability drop, a >10 % LOC change, a platform fact worth remembering) — for Jonas to decide.

## Platform facts learned (edge vs workerd)

## Bigger refactors (allowed by capability, too big for the loop)

## Capability-dropping options (faster, but they take something away)

## F-subreq — the per-invocation subrequest cap bounds single-session append bursts (2026-09-03)

Measured on the deployed worker: 100 `itx.append` calls pipelined over ONE capnweb WebSocket abort
with `Too many API requests by single Worker invocation`. Mechanism: the stateless `/api` worker
holds the socket; each client call becomes one Workers-RPC subrequest to the DO, all attributed to
the single stateless invocation that is pumping that socket, so ~1,000 in-flight calls trip the cap
(`limits.subrequests`, default 1,000; Cloudflare docs workers/platform/limits). A batched append (one
call, N events) is ONE subrequest and does not — 100 events batched cost 34.8 ms and one subrequest.

Why it matters and options (all capability-neutral, none small):

- It is the same class as apps/os's 10,000-delivery silent wall (review measure-next #1) but at the
  APPEND door, and it is LOUD (an error), not silent.
- Raising `limits.subrequests` to the 10,000 max buys 10× headroom for one config line, no code —
  worth doing regardless; a client can still exceed it.
- The durable answer is client-side: the SDK/client could coalesce a burst of single appends on one
  session into one multi-event append (the wire already supports N events per append). That is a
  client change, out of this loop's scope, and belongs with the connection-ergonomics work.
- The bench now guards this scenario (fewer in-flight, or a note) so a run completes.

## W3 — zod is in the worker script twice (~600 KiB of 1,225 KiB); removing it is a refactor, not a loop item (2026-09-03)

Verified on the deployed script: zod appears twice — ~303 KiB as main-worker code (the 8 core
schemas in `src/stream/core-processor.ts`, via `src/stream/events.ts` `defineProcessorContract`) and
~303 KiB inside the `processor.js` SDK string (`src/generated/processor-sdk.ts`, injected into facet
isolates). Together ~half the 1,225 KiB upload and the dominant cold-isolate parse cost.

Verified it is SCRIPT-SIZE / COLD-BOOT only, NOT a per-append cost: zod `.parse` on the main worker
runs at exactly (a) `stateSchema.parse({})` — initialState, at construction / version re-reduce;
(b) `payloadSchema.parse(...)` inside `CoreContract.buildEvent`, called only when BUILDING a core
control event (rewrite-rule-configured, subscription-configured) — never for a plain user
`itx.append`; (c) `SubscriptionName.parse` at subscribe. A `bench/ping` append does zero zod. So the
win is the ~490 ms cold start and resident memory, not append latency.

Why it is not a loop no-brainer (both options are real refactors with a tradeoff):

- **The two copies cannot be shared.** The SDK zod lives in a separate V8 isolate (the confined
  facet); the main-worker zod is the parent's. Dedup is impossible without changing the confinement
  model.
- **The SDK copy cannot switch to zod/mini.** Userspace processors author state schemas with full
  zod's CHAINED builders (`z.object({ counts: z.record(...).default({}) })` — the fixtures do), a
  public authoring API. Switching the SDK to mini breaks it. SDK zod stays.
- **The main-worker copy (option a: zod/mini):** −285 KiB (303 → ~18 KiB). But `core-processor.ts`
  is written in chained builders (~22–32 `.optional()/.default()/.regex()/.int().positive()` sites)
  that mini lacks (`z.optional(...)`, `z._default(...)`, `.check(z.regex(...))`) — a wholesale
  rewrite of the most-read declaration in the package, and a SECOND zod dialect in one package. ~30–100
  lines, behaviour-identical. Capability-neutral; the cost is maintainability (two dialects).
- **The main-worker copy (option b: drop zod):** hand-write `initialState()` and the few door checks
  (`subscriptions.ts`, `itx-expression-rewriting.ts` already half-do). ~−40 lines, but retires the
  "built-ins get schemas, same as userspace" symmetry (`events.ts`, `processor.ts`) — a doctrine
  change, the owner's call.

Recommendation: option (a) if the 285 KiB / faster cold start is wanted and a second zod dialect is
acceptable; otherwise leave it. Re-measure the upload after either. NOT done in the loop because it
is neither small nor free of a design choice.

## The menu after reader-workflow round 1 (2026-09-03) — sized, capability-neutral unless noted

Ordered by deployed value per LOC. All keep every event durable (woken included) and drop no
capability. "Deployed value" = shows on Cloudflare cpuTime/wallTime or client latency; several are
invisible at today's small fixtures and only matter at scale — said where.

### Latency (deployed, client-facing)

- **LANDED 2026-09-04 — Fold `attachRpcStubPager` into the pager upgrade, AND the rule/row append
  with it.** A `provide(stub)` / `subscribe({target: fn})` did the `attachRpcStubPager` RPC, the
  pager WS upgrade, then its own `append` of the rule / the row: THREE edge→DO round trips. Now the
  upgrade header carries `{ rpcStubKey, appendEvents }`, the DO accepts the socket and appends in one
  synchronous turn (a refusal = 409 + the code, no socket): ONE round trip, −2 subrequests per
  provide/subscribe-with-callback; the verb, its pending map and the 409 "attach first" branch are
  gone. Pinned by `__workers-tests__/rpc-stub-pager-attach.test.ts` (census + atomic refusal) and
  `e2e/rpc-stubs-attach-carries-the-rule.e2e.test.ts` (the rule's offset is below the key's
  `attached`; red on the previous protocol).
- **Defer the post-commit fan-out to a macrotask (latency/medium, +3/−1 stream.ts).** The append
  reply is gated on the commit's replication confirm (~10 ms deployed); the fan-out runs
  synchronously before the reply escapes, so today reply ≈ confirm + fan-out-sync. Queue the fan-out
  as a macrotask and reply ≈ max(confirm, fan-out) — up to ~10 ms of fan-out CPU hidden per durable
  append at many rows, ≈0 at few. Risk: reorders onCommit relative to the waitForEvent waiters
  ("waiters first" today); needs an ordering proof.
- **Facet checkpoint as `allowUnconfirmed` / skip the cursor put when nothing was consumed
  (latency, processor.ts + SDK host).** A facet's storage write holds its reply's output gate ~10 ms
  on the edge. Two levers: (a) write the cursor unconfirmed (async), so the reply and the delta
  append don't wait for the facet's own storage confirm; (b) skip the cursor put when a push consumed
  nothing and state didn't change. NUANCE found in-loop: onCommit only pushes matching events to a
  filtered facet, so a filtered facet ALWAYS consumes its steady-state pushes — (b) helps mainly
  CATCH-UP / gap-repair over a log of non-matching events (overlaps M2), not the green path. (a) is
  the broader win but changes the facet's durability to "confirmed shortly after reply" — an
  at-least-once-safe relaxation, but state a doctrine line. Both regenerate the SDK bundle.
- **Arm the quiet-clock alarm `allowUnconfirmed` (latency/low, +3).** The first facet-touching read
  after each idle→active transition waits on the alarm-manager sync + commit; unconfirmed removes
  that from the reply. Once per quiet window per context.

### Throughput / CPU (deployed, at scale)

- **Per-commit fan-out CPU at many rows (cpu, subscription-delivery.ts):** three readers found O(rows)
  work per commit — re-resolving each row's target head + minting a handle/Proxy (memoize per row
  identity, +10/−1, ≈−1–4 ms at 200 rows); allocating a filtered batch copy per default/`*` row
  (share when no ephemerals, +4/−1, ≈−1–3 ms at 200 rows). ≈0 at ≤10 rows. Bundle together.
- **`#unsetWhatNamesRpcStub` / racing-delete re-read JSON5-print or re-read the whole inline source
  (cpu, iterate-context-durable-object.ts):** per last-pager close and per facet push at 300–600 KB
  inline sources, O(Σ source) work → O(rows) field compares / a per-name delete generation. Zero at
  fixture sizes; overlaps M1 (get the source OUT of core state and these all shrink).
- **Coalesce queued pushes into one `processEventBatch` per facet when behind (throughput/medium,
  +15/−5):** a burst of K appends into one processor pays K confirms; coalescing pays ~2. Contiguous
  range chain preserved.
- **Multi-row INSERT / IN-list SELECT for a batched append (throughput/low, +10–14):** −(N−N/16)
  statement dispatches per N-event batch, ≈−0.3–0.5 ms of the 4.78 ms for 100 events; zero for
  single-event (the dominant path).
- **Drop the UNIQUE index write for keyless events (cpu/low, +8/−2):** idempotency keys in their own
  table → −1 row per keyless durable event (4→3 for a 1-event append, −25% of its storage-write
  bill). A storage-schema change.
- **Edge-side `invokeMany` coalescing (throughput/low, +25–35):** K concurrent edge `invoke`s in one
  turn → 1 DO call. Only worth it if the subrequest ceiling turns out non-configurable — it IS
  configurable (done), so this is lower priority now.

### Boot / script size

- **W3(b): delete runtime zod from the main worker (script-size/high, ≈ −40–60 net LOC):** −310 KB
  minified (−37%), ≈−6 ms cold isolate. Core contract becomes a TS type + literal initialState;
  `defineProcessorContract` moves to the SDK. Capability-neutral per the reader (core events are
  trusted, snapshot shape identical) BUT retires the "built-ins get schemas like userspace" symmetry
  — a doctrine call. THE biggest single script lever; owner decision (see the W3 section above).
- **Ship the SDK as a wrangler Text module, not a 394 KB escaped string literal (boot/medium,
  +6/−2):** −1.5 ms compile per cold isolate, −10 KB upload, −1 huge generated TS file from
  typecheck. Byte-identical injection. RISK: the vitest pool-workers + esbuild test lanes must
  resolve a Text-module import the way deploy does — verify before landing.
- **Bench: add a RE-WAKE lane (boot/high, bench-only):** no wake-side change is provable on the
  deployed worker without it. Expected ≈150–250 ms re-wake vs ≈20–40 ms warm. Do this before any
  boot/wake item above.

### Correctness-adjacent (from the append reader, not a perf item)

- `transactionSync`'s SAVEPOINT/RELEASE are the only UNPREPARED statements on the commit path
  (workerd has a `TODO(perf)`); state-put-first ordering could retire the explicit transaction
  (−2 dynamic prepares/commit). Measure first; it is a correctness trade (rollback semantics).

## Platform facts learned from source (workerd / capnweb / cloudflare-docs), round 1 (2026-09-03)

These bound what the clean room can gain; verified by reading, not measured unless noted.

- **DO storage writes commit once per event-loop turn, gated.** Every SQLite/kv write between two JS
  awaits joins ONE implicit transaction; the COMMIT (and the durable `commitCallback`) runs after a
  later turn (`co_await kj::yield()`), and the OUTPUT GATE holds every outgoing message — including
  an RPC reply — until that commit confirms durable (~10 ms, matches the measured durable-vs-ephemeral
  append gap). So: (1) many writes in one turn cost ONE commit, not N; (2) a reply is gated on the
  confirm, which is why `allowUnconfirmed` and "reply before the write" levers exist; (3) 100
  pipelined appends CAN share one commit if they land in one turn.
- **`sql.exec` prepared-statement cache is per-DO-incarnation, LRU 1 MiB, keyed by string identity.**
  Every wake re-prepares each distinct SQL string on first use. `transactionSync`'s SAVEPOINT/RELEASE
  are built with `kj::str` and run UNPREPARED every call (workerd carries a `TODO(perf)`); they are
  the only unprepared statements on our commit path.
- **`ctx.storage.kv` is SQLite** (`_cf_KV`, prepared once/db): each `put` is a `serializeV8Value`
  (structured-clone) + UPSERT row; each `get` a SELECT + deserialize. rows_written / kv get/put are
  traced spans, but NOT in `wrangler tail --format json`'s default output — proving a per-commit row
  count needs a trace, not a tail.
- **`setAlarm` writes nothing when the time is unchanged**, and moving the alarm EARLIER makes the
  commit await an alarm-scheduler round trip before it commits. Our `armAlarmNoLaterThan` memo already
  limits it to one write per quiet-period start.
- **The subrequest cap is per top-level invocation** (paid default 10,000, max 10,000,000, configurable
  via `limits.subrequests`); a long-lived capnweb WS session accumulates against its one pump
  invocation. A DO's own limits (30 s wall unless doing I/O, 128 MB) are separate.
- **Worker Loader (`env.LOADER.get`) caches isolates per id; a named startup failure stays in the map
  until aborted** (the bug we fixed in `f974cf47f`); cacheKeys are billed Dynamic Worker identities.
- **capnweb** pipelines property AND call access on an unresolved promise (one round trip for an
  N-step chain); each call is a small JSON frame over the WS. The append path carries ZERO zod
  parses (zod runs only building a control event and at construction).
- **Cold script parse** dominates cold start: the ~843 KB minified worker is ~6 ms compile + ~4.6 ms
  eval locally; zod is ~2.2 ms of the eval, the 394 KB SDK string ~1.5 ms of the compile.
