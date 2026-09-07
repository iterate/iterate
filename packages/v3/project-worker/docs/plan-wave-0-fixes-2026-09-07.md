# Wave 0 — what the v4 review found wrong in the clean room as deployed, and the plan to fix it

> Scope: ONLY the defects in shipped v3 that the 2026-09-07 review of `packages/v4` surfaced. Everything else the
> review produced — the eleven feature reviews, the layering verdict, the tech tree of what to take from v4 and in
> what order — is PARKED in `docs/plan-v4-features-layered-on-v3.md` (committed b5e31c7c0) with the raw reviews in
> `docs/reviews/2026-09-07-v4-*.md`; the surface of record points at both from its §12 Open list. Nothing in this
> file adds a feature. Each issue: what it is exactly, why it matters, how it is proved, the fix, its size, and who.

## Issue 1 — the open wildcard: anyone on the internet can create Durable Objects

**What happens, step by step.** Tonight's ingress (773978230) deployed a wildcard DNS record and route,
`*.project-worker.iterate.com`. The edge (`src/worker.ts`, the `projectHostOf` branch) parses any hostname
`<label>--<projectId>.project-worker.iterate.com` into a project id and an app label, and dials the project's ROOT
context by name — `env.ITERATE_CONTEXT.getByName("<projectId>.iterate/")` — with the Request. A context is created on
first touch: `IterateContextDurableObject`'s constructor appends `stream/created` and `stream/woken` synchronously
(`src/stream/stream.ts:24-26`: "a probe on a never-seen context materializes it — deliberately"), which opens the
DO's SQLite storage and writes rows. Only then does the fetch lane look for the rule `itx.apps.<label>`, find none,
and answer 404.

**So:** `curl https://x--anything.project-worker.iterate.com/` — no credential, no session — creates a durable,
storage-backed Durable Object for project `anything`, and the next label creates the next. Unbounded, from the public
internet, billed to us. Before tonight this could not happen: a project was reached only through `/api` (a capnweb
session) or `/expression?context=` on the worker's own hostname, both of which a stranger could also hit — but
those were never advertised as public URLs, and the whole point of ingress is that project hosts ARE public URLs.
v4 answers 421 for a host it does not know BEFORE any DO is dialled (`src/ingress.ts`); that is the thing to take.

**Proof (red today):** `curl -s -o /dev/null -w '%{http_code}' https://never--seen-before-1.project-worker.iterate.com/`
answers 404, and `itx.readEvents()` on project `seen-before-1` afterwards shows `stream/created` + `stream/woken` —
the context now exists. An e2e row will pin the fix: an unknown host answers 421 and the project's log stays empty.

**The fix: admission at the edge, before the DO is dialled.** The edge must be able to say "this project serves
hosts" without touching the DO. Two designs; pick one:

- **A. Serving is opt-in, recorded where the platform already writes.** When a context commits its FIRST
  `itx.apps.<label>` rewrite rule, the DO writes a physical index key to the worker's KV (`ITX_KV`,
  `project-host:<projectId>` → the labels), and deletes it when the last such rule goes (the core reduce's commit
  effects already own "what changed in the rule table"). The edge reads that key before dialling — cached per isolate
  for a minute — and answers 421 when absent. No directory, no redeploy, no control plane: "an app is one rule row"
  stays literally true, and a project that never configured an app simply has no hosts. Cost: KV is eventually
  consistent (a write is visible within ~60 s globally, usually at once from the writing colo), so a freshly
  configured app can 421 for up to a minute in another colo; the e2e waits for it. ~40 lines: the DO's index write
  (~15), the edge check + cache (~15), a config row for the local lane (~5), the e2e (~25).
- **B. A directory in the control plane.** The control-plane shell over `FALLBACK` answers
  `resolveProjectHostname(hostname) → { projectId, label } | null` (strongly consistent, and the same row later
  carries pretty slugs and custom domains); a config map `APP_CONFIG_PROJECT_HOSTNAMES_JSON` stands in for the solo
  and workers lanes. Cost: the shell has no table yet (`control-plane-shell/src/index.ts` is a stub whose
  `invokeCapability` answers `{ ok: true }` unconditionally), so this is ~50 lines in the worker plus the shell's
  first real state, and a project that wants a host has to be registered somewhere other than its own log.

**DECIDED (Jonas, Plannotator 2026-09-07): B.** The control plane is "super mega simple": one Worker reached over
Workers RPC, a D1 database through sqlfu (as the sqlfu GitHub examples do it) that knows which projects exist —
and that is it. Design A is dropped. The edge asks that control plane before it dials a DO; an unknown host is 421.
**Also take from v4, 2 lines:** normalize the Host (strip a trailing `.`, a leading `*.`) — a fully-qualified
`Host: site--p.project-worker.iterate.com.` misses `projectHostOf`'s `endsWith` today and falls through to the
platform doors instead of the app.

**Effort:** ~3 h with the deployed proof. **Owner:** this session (the control plane, worker.ts, project-host.ts, app-config).

## Issue 2 — the clean room only works because of a patch that is not in the repo

**What happens.** The expression codec (`src/context/expression.ts`) hands call arguments to `JSON5.parse`. A large
literal — the case that exists today is a processor's source inlined into a rewrite target or a `configureProcessor`
call, 4.5 MiB in v4's own probe — goes into json5 2.2.3 unbounded, and stock json5 allocates per character: the
budgets review re-ran v3's own `parse` seam in a Node child at `--max-old-space-size=128` (the DO's ceiling) and got
a fatal out-of-memory on stock json5, and 233 ms / 45 MB heap on the PATCHED json5. This worktree has v4's
`patches/json5@2.2.3.patch` (299 lines) installed through an UNCOMMITTED `pnpm-workspace.yaml` entry — so v3's unit
lane passes, and tonight's deployed bundles (wrangler bundles from `node_modules`) carry the patched json5 too.

**So:** any other checkout — CI, a fresh clone, a colleague's machine — has stock json5, and there a 4.5 MiB literal
kills the DO isolate mid-parse (a reset, with the 30-second CPU budget as the other ceiling). Our green board is
partly an accident of this worktree.

**Proof (red on a clean checkout):** `expression-memory`-style child test: parse a 4.5 MiB literal under
`--max-old-space-size=128` with stock json5 → OOM. Today's tree cannot show it red without reverting the patch.

**DECIDED (Jonas): a MUCH lower cap, and the parsed form for anything big.** A string itx expression is for what
a person types; it is refused above a couple of kilobytes with a descriptive error that says to pass the parsed
form (the array) instead — the array form carries any argument as plain data and never meets json5. So the cap in
`expression.ts` before `JSON5.parse` is ~2 KiB, coded `EXPRESSION_TOO_LARGE`, and the tests that inline a worker
source into a string target move to the array form. Two notes for the Misha conversation: whether the parsed form
should be the canonical wire shape everywhere; and whether built-in targets should be strongly typed (the shape of
a worker loader's args known to the codec) rather than parsed text. And
the thing that lets a source that large in at all: the facet startup memo (`kv.put('facet:<name>')`) has no ceiling,
so an oversize source fails LATE at materialization and is re-parsed from the log on every post-eviction wake — a
ceiling on the memo (~20 lines in `core-processor.ts`, one error code, a `CoreContract.version` bump so every context
re-reduces once on its next wake). Then the json5 patch is unnecessary for the clean room and can be dropped from
`pnpm-workspace.yaml` by whoever owns that change (other workspace consumers unaudited — a decision, not code).

**Effort:** ~1.5 h with the deployed proof (a refused 4.5 MiB `configureProcessor`, atomic: no facet installed,
neither row landed). **Owner:** this session (expression.ts; core-processor.ts is d3's — the memo ceiling hunk goes to
d3 or by agreement).

## Issue 3 — two things to MEASURE before anyone writes a fix

**3a. Loaded isolates may be emitting native failure telemetry on every WebSocket and every outbound fetch.**
_To be clear, because the sentence reads worse than it is:_ a dynamic worker CAN serve WebSocket upgrades and CAN
fetch out — `e2e/fetch-door-dynamic-live-ws` and tonight's ingress WebSocket row prove it end to end, bytes correct,
clean close. The finding is only that Cloudflare's own trace for such a request may record an `exception` /
`canceled` outcome on the parent span although the request succeeded — a telemetry (and possibly billing or
error-rate) artefact of the named-loader + `globalOutbound` shape, not a functional limit.
`packages/v3/project-core-ws-probe` (a sibling experiment, read-only) has dated, deployed A/B traces: a NAMED
`LOADER.get(id, getCode)` whose loaded child either returns a 101 upgrade or fetches through an injected
`globalOutbound` produces native `exception` / `canceled` telemetry rows although every client assertion passes;
`LOADER.get(null, …)` and `LOADER.load()` are clean. v3's loader is exactly that shape —
`src/context/worker-loader.ts` calls `opts.env.LOADER.get(loaderId, …)` under a named cacheKey with
`globalOutbound: opts.itxEntrypoint` — and nothing in v3 (no BUILD-LOG entry, doctrine comment or test) accounts for
it. No user-visible harm was shown: the bytes are right. The risk is what those rows mean at Cloudflare's end
(billing, error-rate views, a future enforcement) and that we are blind to a real failure in the same signature.
**Probe:** run `e2e/fetch-door-dynamic-live-ws.e2e.test.ts` against the deployed worker, read the Workers trace
for that request chain (`wrangler tail` or the dashboard's Workers Logs; observability is on), and count
`exception`/`canceled` outcomes; then repeat with the probe's mitigation (dispose the settled call promise) if the
rows are there. Decides whether the cacheKey strategy everything sits on must change. ~1 h. **Owner:** this session.

**3b. An evicted context with a cursor subscription may be waking, and billing, every 60 seconds forever.**
_Evicted context:_ a Durable Object whose isolate Cloudflare has unloaded from memory after inactivity (the
hibernation / quiesce path); its storage persists, and the next request or the next alarm re-creates the instance —
the constructor runs again, which is where `stream/woken` is appended. **DECIDED (Jonas): this must not be able to
happen — "we need runaway billing controls."** So beyond the probe and v4's fix, wave 0 adds a control: a context
that has woken itself N times in a row from its own alarm with no public door touched in between stops re-arming
the alarm and records why (one durable fact, one log line) until a real request arrives. Pinned deployed.
Read from the code, not run: the alarm fires → the constructor appends `stream/woken` → `onCommit` arms the cursor
alarm and delivers → delivery records activity → `alarm()`'s quiesce branch is skipped and it re-arms at
`lastActivity + 60 s` (`iterate-context-durable-object.ts:531-533`) → the isolate is evicted → repeat. One billed
wake and one durable `stream/woken` row per minute, for every such context, for as long as it exists.
**Probe:** deploy one context with a cursor subscription whose `consumes` includes `stream/woken`, leave it for ten
minutes, count `stream/woken` rows with `readEvents`. If the count climbs, v4's fix (do not fan out the
constructor's own commits until a real public door arrives) is the shape, ~20-35 lines in delivery. ~1 h to probe.
**Owner:** d3 (subscription-delivery.ts is its file).

## Issue 4 — ten kernel fixes v4 made that v3 lacks

Verified against v3's CURRENT files by the kernel-diff review (v4 forked at b1cd35934, so every later v3 commit was
checked). Three small commits, in this order:

**A — memory and correctness core (~60 lines, flips one of v3's own red pins).**

- The core re-reduce is O(rows²): `CoreStreamProcessor` copies the whole subscriptions table on EVERY control event
  (`core-processor.ts:357-372,388-405`). v3's own `memory-budget.test.ts:373` pins it red: "a core-version bump over
  17,000 rows re-reduces O(rows²) in the constructor — 25 s, a reboot loop against the CPU limit". v4's
  `reduceBatch` with per-batch draft tables copies once per 500-event page (32 lines) and turns that test green.
  Note this is exactly the cost issue 2's version bump pays — land A before or with it.
- The SDK host's facet append/read returns the native RPC promise (`sdk/stream-processor-durable-object.ts:87-88`),
  which pins the parent DO until GC — the defect the DO's own `#invokeFacet` already fixes in the other direction.
  `using` on the handle and the result releases it (16 lines).
- A raw `subscription-configured { name: "core" }` installs an undeliverable row today (`core` is guarded at the
  facet doors only) that then climbs the retry ladder to a halt; reserve it at the append door (12 lines).

**B — delivery and lease lifetimes (~85 lines).**

- Halt once, for the right row (`subscription-delivery.ts`): the facet-push path appends
  `subscription-delivery-halted` with no in-flight guard, so a push and a resume catch-up seeing the same
  `retryable: false` both append; `#catchUpFacetRow` never halts on a deterministic refusal, so a facet whose
  checkpoint latched is re-pushed on every commit forever; a queued push checks `if (!push || !row)` and lands on a
  row that halted meanwhile, and on a REPLACEMENT row (49 lines; three unit pins, one deployed).
- A stale `provide` handle tears down its replacement: `RewriteRuleHandle(() => sessionTeardown.dispose(key))`
  disposes whatever sits under the key NOW, so re-provide at the same match then dispose the OLD handle kills the
  NEW pager (`iterate-context.ts:274,317`). The lease is the handle: it forgets itself only while current (23 lines).
- Drop a poisoned DO stub instead of keeping it forever (13 lines; v4's premise that workerd marks a stub broken
  after many exceptions is unverified — cheap either way, and never a retry of the failed call).

**C — hygiene (~35 lines).** A bounded 300-char error-body read instead of buffering a whole body; `close()` over
`Symbol.dispose` in `releaseConnections`, reporting failures; a coded `INVALID_CONTEXT` (a bare `Error` loses its
class across the hop); report instead of swallow in `#unsetWhatNamesRpcStub`. NOT taken (Jonas): classifying platform DO resets as expected interruptions in the logs — they stay visible.

**Not taken:** v4's drift — `stream/processor.ts` 191 → 10 comment lines and `subscription-delivery.ts` 181 → 12
with no behaviour change, 21 abbreviated names, a new noun `ContextLeaseBook`, an uncached SHA-256 content hash that
undoes the measured memo, the hand-written MCP client swapped for the SDK.

**Effort:** A ~3 h · B ~4.5 h · C ~1.5 h, each with a deployed proof. **Owner:** A and B are d3's files (stream, delivery,
the SDK host) — its session; C this session.

## Issue 5 — done tonight: the two loader bugs (b5e31c7c0)

The literal-module content hash was one 32-bit djb2, which collides on two-character differences (`"Aa"` and `"B@"`
both hash to 5,862,151); one shared hash is one shared isolate, its whole world — the owning context's `env.ITX` —
baked in at first materialization. Now djb2 + FNV-1a + the length, still synchronous (it runs in the commit path).
And the loader id was the `:`-joined `${kind}:${deployId}:${owner}:${sourceVersion}`; an owner or a caller's cacheKey
may contain `:`, so two different (owner, key) pairs could name ONE isolate — the cross-context authority transfer
`facetLoaderOwner` exists to prevent, reopened one field over. Now a JSON array. Deployed e0b21345, board
189p/0f; every facet restarted once under its new id, storage surviving.

## Optional, 8 lines — an egress request to the project's own host loops out to the internet

`itx.fetch("https://site--<me>.project-worker.iterate.com/x")` from inside the project leaves through egress, hits the
wildcard, re-enters the edge and dials the same DO — a full external round trip for a call the context could make
itself, and an oddity a router-shaped app will hit. v4 refuses it with a coded error at the terminal. Not a hole
(v3's ingress never enters egress, so it cannot recurse), just waste; take it when touching `#egress` for issue 2.

## Sequence and totals

| #   | item                                                                                                                                                                       | owner                                 | hours   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| 1   | the open wildcard: the minimal control plane (Workers RPC + D1 via sqlfu, "which projects exist"), the edge asks before dialling, 421 + Host normalization, deployed proof | this session                          | 3       |
| 2   | the ~2 KiB string-expression cap (tests move to the array form) + the memo ceiling, then drop the json5 patch                                                              | this session (+ d3 for the memo hunk) | 1.5     |
| 3a  | the loader-telemetry probe                                                                                                                                                 | this session                          | 1       |
| 3b  | the wake-loop probe, then the fix AND the runaway-wake control, pinned deployed                                                                                            | d3                                    | 3       |
| 4A  | core re-reduce, `using` release, `core` reserved at the door                                                                                                               | d3                                    | 3       |
| 4B  | halt-once, lease-is-the-handle, poisoned stub                                                                                                                              | d3                                    | 4.5     |
| 4C  | hygiene                                                                                                                                                                    | this session                          | 1.5     |
|     | **total**                                                                                                                                                                  |                                       | **~18** |

Deploy discipline as always: one deployer at a time, every fix proved against the deployed worker in the sequential
lane, a BUILD-LOG entry per commit, nothing outside the clean room touched.

## Decisions (Jonas, Plannotator, 2026-09-07)

1. Issue 1: **B** — the minimal control plane (Workers RPC, D1 via sqlfu, which projects exist, nothing else).
2. Issue 2: **a cap of a couple of kilobytes on string expressions; big arguments ride the parsed form.** And
   **drop the json5 patch.**
3. Issue 4C: **keep the reset logs visible.**
4. Issue 3: order is the implementer's call — d3 starts 4A in parallel with the 3b probe; the runaway-wake control is
   mandatory, not optional.
5. For Misha: the parsed form as the canonical wire shape; strongly typed built-in targets.
