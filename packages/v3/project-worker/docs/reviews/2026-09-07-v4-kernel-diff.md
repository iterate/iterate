# The kernel diff: v4 vs v3 in the 34 files both trees have

**Fork point measured, not assumed.** I diffed every changed file against the last 8 v3 commits touching it.
`stream/live-state.ts` is byte-identical to v3@`ce503fdc1`, `live-state.test.ts` to v3@`72378b0e5`; every
other file's minimum distance is `b1cd35934` or older. **v4 forked v3's working tree at `b1cd35934`
(2026-09-06, "review round 2, phase 2").** Ten v3 commits landed after and are absent from v4: `45856e576`
(edge#10), `63c9474ad` (live-state reorder), `773978230` (ingress + identity), `76e7baa70`+`674a5704a`+
`2bb4a65e2` (read-admission ceiling), `ef7c1c883` (delivery budgets 16→8 MiB), `4147f60fc` (facets classified
as push rows at catch-up), `0bf157dd1`+`e38f787e4` (facet-push gate, added then reverted). v3's
`packages/v3/project-worker/src` is clean at HEAD `e38f787e4`. Totals over the 34 shared files: code
6,283 → 7,178 (+895, nearly all feature); comments 2,601 → 2,185 (−416, concentrated — §3).

## 1. The 34 changed files, classified

`(a)` feature — the named reviewer covers it · `(b)` a fix v3 lacks · `(c)` v3 moved past it · `(d)` cosmetic.

| File | Δ | Classification |
|---|---|---|
| `stream/subscription-delivery.ts` | 1050 | **(d)** wholesale de-narration + short-name rename (§3) · **(b)** halt dedupe/identity (§2.3) · **(c)** budgets 16/16 vs v3's 8/8 (`ef7c1c883`), no push-row classification at catch-up (`4147f60fc`) · **(a)** `appendSystem` in `#halt`, `maxThrough` (budgets) |
| `stream/processor.ts` | 652 | **(d)** 100%: 191→10 comment lines, every private renamed. Zero behaviour change — I traced `#applyBatch`, `#replayDurable`, `#reduceAndProcess` hunk by hunk |
| `stream/stream.ts` | 566 | **(c)** the whole read-admission gate deleted (`674a5704a`), `read` back to sync, budget 16→32 MiB · **(a)** `StreamCommitParticipant` (repos), `appendSystem` (provenance), `assertAppendInputShape`/`ReplyShape`, resource halt, `READ_PAGE_PARSED_BUDGET_BYTES` (budgets) · **(d)** `#coreReducedThroughOffset` dropped, `#retireOutstandingReadPage` restated identically |
| `iterate-context-durable-object.ts` | 557 | **(a)** repos/trust/fetch-policy participant, `putSecret`, `build`/`check`, ingress egress guard · **(b)** wake-fan-out gate (§2.5), `reportIssue` on stub-cleanup failure · **(c)** identity (`invokeAs`), `readInternal` · **(d)** `@v3/shared/egress` vendored |
| `iterate-context.ts` | 429 | **(b)** `#withDurableObject` (§2.7), lease semantics (§2.6) · **(a)** `assertAppendRequestAdmission`, `awaitAndReleaseInertRpcResult` (§6 Q4) · **(c)** identity |
| `library/mcp.ts` | 348 | **(d)** hand-written JSON-RPC client replaced by `@modelcontextprotocol/sdk` (§3.4, §6 Q3) · **(b)** lazy reconnect + `onerror` capture |
| `stream/memory-budget-scenarios.ts` | 267 | **(c)** `concurrent-readers` scenario deleted · **(a)** halt/refusal fixtures |
| `session.ts` | 232 | **(b)** `ContextLeaseBook` (§2.6) · **(c)** identity: `authenticate({projectToken})`, `whoami`, `FORBIDDEN` all gone; `authenticate` is a no-op again |
| `context/worker-loader.ts` | 225 | **(a)** `loadNativeWorker` + cache digest · **(b)** `loaderIdBase` JSON-delimited (§2.9) · **conflict** uncached SHA-256 replaces v3's memoised djb2 (`a71cfad12`) — §6 Q5 |
| `stream/core-processor.ts` | 221 | **(b)** `reduceBatch` + draft tables — flips v3's open red pin (§2.1); `assertCoreControlEventMayLand` (§2.4); `Object.hasOwn`/`defineProperty` prototype-key hardening · **(a)** `FacetStartupMemoAdmissionError` |
| `worker.ts` | 215 | **(a)** ingress, `/secrets`, `/mcp`, demo login, RPC admission · **(c)** v3's `<label>--<projectId>.<base>` ingress + principal header · **(d)** `CODE_VERSION` live-47 (v3: live-53); Host-header rewrite (§6 Q6) |
| `context/built-ins.ts` | 194 | **(a)** `repos`/`secrets`/`approvals`/`build`/`check`/`workers.load` roots · **(c)** `stampPrincipal` on `append` · **(d)** `callWorker`/`workerHandle` extraction |
| `context/rpc-stub-relay.ts` | 174 | **(c)** entirely: v4 is the pre-`b1cd35934` file — edge#13's `lendEnded.reason` re-coding is missing · **(d)** `ClientRpcStub` typed as capnweb's `RpcStub` |
| `stream/stream-storage.ts` | 165 | **(a)** halts table, activity head, parsed-byte estimator · **(d)** header comment gutted (43→32) |
| `lib/errors.ts` | 164 | **(a)** 30 new codes + `policyErrorResponse` · **(b)** `isRetryableDurableObjectReset` + the `expected_platform_interruption` log branch (§2.8) · **(c)** `INVALID_CREDENTIALS`/`FORBIDDEN` dropped |
| `stream/memory-budget.test.ts` | 141 | **(b)** three `test.fails` flipped green (§2.1, §2.2) · **(c)** both concurrent-reader tests deleted |
| `context/worker-loader.test.ts` | 136 | **(a)** native-load cache tests · **(d)** loaderId literals |
| `stream/subscription-delivery.test.ts` | 122 | **(a)** two new activity-head/cap tests (§2.5 evidence) |
| `stream/live-state.ts` | 106 | **(c)** exactly v3@`ce503fdc1` — v4 predates the delta-append chain (`63c9474ad`) |
| `context/itx-expression-rewriting.ts` | 98 | **(b)/(d)** `directRpcStubKey`+`resolvedRpcStubKey` dedup two copies of the stub matcher into one |
| `review-bugs-round2.test.ts` | 86 | **(c)** v3's edge#10 test has 2 assertions v4 lacks · **(d)** MCP-SDK fixture churn |
| `app-config.ts` / `app-config.test.ts` | 86/80 | **(a)** `APP_CONFIG_PROJECTS_JSON`/`CUSTOM_HOSTNAMES_JSON` + a `stringRecord` parser · **(c)** `projectTokenSecret` removed |
| `stream/live-state.test.ts` | 69 | **(c)** pre-`63c9474ad` · `library/mcp.test.ts` 67: **(d)** SDK fixtures, **(b)** a "memoized holder reconnects after close" test |
| `context/expression.ts` | 66 | **(c)** v4 found edge#10 independently — same bug, different spelling; v3's `45856e576` is the stronger form (it also covers `MARKERS_IN_PRINT`) |
| `stream/events.ts` | 61 | **(a)** `provenance`/`verification` + idempotency-body extension · **(c)** `source.principal` |
| `library/index.ts` | 55 | **(b)** `responseTextPrefix` bounded body read; `close()`-preferring + reporting `releaseConnections` (§2.10) |
| `sdk/stream-processor-durable-object.ts` | 41 | **(b)** `using` release of the native append/read RPC promises (§2.2) |
| `itx-entrypoint.ts` | 41 | **(c)** principal-header strip · **(d)** doc |
| `context/durable-object-names.ts` | 21 | **(b)** `codedError("INVALID_CONTEXT")` instead of a bare `Error` |
| `built-in-roots.ts` 14 · `boundary.test.ts` 14 · `egress.test.ts` 11 | 39 | **(a)** five feature roots · **(d)** boundary relaxed for the MCP SDK; vendored import path |

17 v4-only files (2,929 code lines) belong entirely to the feature reviewers: `fetch/policy.ts` 535,
`client/docs.ts` 495, `provenance.ts` 310, `repos.ts` 275, `auth.ts` 236, `bundler.ts` 224,
`context/rpc-admission.ts` 184, `stream/resource-budget.ts` 188, `mcp-server.ts` 71, `build.ts` 51,
`ingress.ts` 47, `fetch/secret-substitution.ts` 34, plus 5 test files.

## 2. Fixes v3 should take

Each verified against v3's *current* file, not the fork point.

**2.1 `CoreStreamProcessor.reduceBatch` + per-batch draft tables — flips v3's open red pin (32 code lines).**
`v4:stream/core-processor.ts:333-352,383-400`. v3 spreads the whole subscriptions table on *every* control
event (`v3:stream/core-processor.ts:357-372,388-405`), which is the exact quadratic v3's own pin names:
`v3:stream/memory-budget.test.ts:373` `test.fails("core re-reduce: a core-version bump over 17,000 rows
re-reduces O(rows²) in the constructor — 25 s, a reboot loop against the CPU limit")`. v4 copies each table
once per *page* (500 events) behind a `WeakSet` of drafts and turns that same test green with the same
`rereduceMs < 15_000` bound. I traced the aliasing: the WeakSet is fresh per batch and the published table is
never in it, so the first update always copies — intermediate states are unobservable and a mid-batch throw
rolls back with the transaction. The highest-value item in the diff. *(v4 asserts green; per the brief I did
not run v4's tests — but the mechanism is precisely the quadratic v3 pinned.)*

**2.2 Release the native RPC promise for the SDK's append/read (16 lines).**
`v4:sdk/stream-processor-durable-object.ts:87-110`: `using itx = await this.env.ITX.get(); using result =
itx.builtins.append(...)`. v3 (`:87-88`) returns the promise, so every facet append/read leaves the call
pipeline pinning the parent DO until GC — the same defect the DO's own `#invokeFacet` already fixes in the
other direction (`v3:iterate-context-durable-object.ts:687-696`). Directly on d3's memory arc.

**2.3 Delivery: halt once, for the right row (49 lines: `#haltDeterministic` 27 + `#halt` 13 + `#retryOrHalt`
9 + a 2-line `#isCurrentActiveRow`).** Three defects in v3's `stream/subscription-delivery.ts`: (i) it appends
`subscription-delivery-halted` from the facet-push path (`:640-651`) with no in-flight guard, so a push and a
resume-catch-up seeing the same `retryable:false` both append — v4 serialises on a `#halting` map;
(ii) `#catchUpFacetRow` (`:296-309`) never halts on a deterministic refusal, so a facet whose checkpoint has
latched is re-pushed on every commit forever; (iii) the queued push closure checks `if (!push || !row)`
(`:388`), so a row that *halted* while the push was queued still gets pushed — v4 adds `|| row.halted`, and
gates on `configuredAtOffset` identity so a replacement row never receives its predecessor's push.

**2.4 Reserve `core` at the append door (10 lines + one error code).**
`v4:stream/core-processor.ts:271-281` `assertCoreControlEventMayLand`, called from `Stream.#commit`. v3
guards `core` at the facet doors only (`v3:iterate-context-durable-object.ts:556,717`); `parseSubscriptionName`
accepts `core` (`:238-245`), so a raw `subscription-configured { name: "core" }` installs an undeliverable
row that then climbs the retry ladder to a halt. v3 has no test for this.

**2.5 The alarm wake loop (v4: ~35 lines + 2 storage methods; a v3-shaped fix is smaller).**
`v4:iterate-context-durable-object.ts` `#collectWakeCommits`/`#pendingWakeCommits`/`#flushWakeCommits`.
Reading v3: an evicted context with a **cursor** subscription consuming the wake type fires its alarm → the
constructor appends `stream/woken` → `onCommit` arms the cursor alarm (`v3:subscription-delivery.ts:194-195`)
and delivers → the delivery records activity, so `alarm()`'s quiesce branch is skipped and it re-arms at
`lastActivity + 60 s` (`v3:iterate-context-durable-object.ts:531-533`) → evicted → repeat. One billed wake and
one durable `stream/woken` row per minute, forever. v4's fix — do not fan out the constructor's own commits
until a real public door arrives; `alarm()` deliberately does not flush — is sound, though its
`activityHead`/`maxThrough` threading is heavier than v3 needs. **Inferred from code, not run.**

**2.6 A stale `provide` handle must not tear down its replacement (23 lines).**
v3 `RewriteRuleHandle(() => this.#sessionTeardown.dispose(key))` (`v3:iterate-context.ts:274,317`) disposes
*whatever* currently sits under the key. Re-provide at the same match (a reconnect) then dispose the old
handle → the **new** pager dies. v4's `ContextLeaseBook.lease()` (`v4:session.ts:55-77`) makes the lease the
handle: it forgets itself only if still current, always releases its own pager, and runs the durable `undo`
only while current.

**2.7 Drop a poisoned DO stub instead of keeping it forever (13 lines).** `v4:iterate-context.ts:343-356`
`#withDurableObject`. v3 mints the stub once in the constructor (`v3:iterate-context.ts:154`) and never
replaces it. v4's premise — "Cloudflare marks a stub broken after many exceptions" — I could **not** verify
against workerd source; the fix is cheap either way and never retries the failed call.

**2.8 Stop logging platform DO resets as `event:"issue"` (21 lines).** `v4:lib/errors.ts:109-141,185-197`:
`retryable && durableObjectReset && !overloaded` logs `console.info({event:"expected_platform_interruption"})`
and returns. De-noises the logs — but see §6 Q2: it also *hides* the resets.

**2.9 `loaderIdBase` as JSON, not `:`-joined (1 line).** `v4:context/worker-loader.ts:336`. v3
(`:333`) composes `${kind}:${deployId}:${owner}:${sourceVersion}`; `sourceVersion` is a caller-supplied
`cacheKey`, so a `:` in it can alias two different owners' isolates — and an isolate captures its context's
ITX binding on first materialisation. Changing this is a one-time loader-cache flag day (every isolate reloads
once).

**2.10 Small hygiene (24 lines).** `responseTextPrefix` (`v4:library/index.ts:143-155`) reads and cancels
after 300 chars instead of `await response.text()` buffering a whole error body; `releaseConnections` prefers
`close()` over `Symbol.dispose` and reports failures; `codedError("INVALID_CONTEXT")` in
`context/durable-object-names.ts:59` (a bare `Error` loses its class across the hop); and
`#unsetWhatNamesRpcStub` reports instead of `.catch(() => undefined)`.

## 3. Drift that is NOT a feature

**3.1 The narrative was deleted from the two most-read kernel files.** `stream/processor.ts`: 191 → 10
comment lines (code 334 → 297, zero behaviour change). `stream/subscription-delivery.ts`: 181 → 12.
`stream-storage.ts`'s table map and `stream.ts`'s ephemeral/durable-mark contract are gone. The concurrency
contract (rules 1–5), "ephemerals cost zero writes", why `read()` never proves past the durable mark, why the
pending-push budget is 8 MiB and not 16 — all folded into 2–3 line summaries. Invisible to a feature reviewer,
because the *features* are elsewhere.

**3.2 Fully-qualified identifiers un-qualified — HARD-rule violations.** 21 in the two kernel files alone.
`processor.ts`: `#reducedState`→`#state`, `#reducedThroughOffset`→`#cursor`, `#serialBatchChain`→`#chain`,
`#waitUntilProcessedWaiters`→`#waiters`, `#runOnSerialChain`→`#onChain`, `#reduceAndCommitEventBatch`→
`#applyBatch`, `#rereduceIfVersionChanged`→`#rereduceIfNeeded`, `#writeCheckpointOrLatch`→`#writeCheckpoint`.
`subscription-delivery.ts`: `#deliveryChainBySubscription`→`#chains`, `#pendingPushByRow`→`#pending`,
`#pushSubscriptionNames`→`#pushRows`, `#evaluatedTargetHeadByRow`→`#targetCache`, `serializedChars`→`chars`,
`deterministicFailure`→`cannotRetry`, and every budget constant to `MAX_*`/`CALL_WATCHDOG_MS`.

**3.3 A concept rename with no owner: `SessionTeardown` → `ContextLeaseBook`,** re-exported as
`export { ContextLeaseBook as SessionTeardown }` for the standalone entrypoint (`v4:session.ts:79`). The
*semantics* are an improvement (§2.6); the noun is new and unowned, and both names now live in the tree.

**3.4 The library boundary was relaxed.** `library/boundary.test.ts` now allows
`@modelcontextprotocol/sdk/client/{index,streamableHttp}.js` and `../lib/errors.ts`. v3's `library/mcp.ts` is
a self-contained JSON-RPC client written against `itx.fetch` alone — precisely so the library tier stays
"first-party code that takes only `itx`". Pulling an npm SDK into the edge/DO script also runs against
`d06a179ab` ("delete zod from the edge/DO script — Worker Startup Time 18→7 ms, upload 1,226→695 KiB").

**3.5 `@v3/shared` was dropped.** `substituteHeaderSecrets` is vendored into
`v4:src/fetch/secret-substitution.ts` (34 lines); `package.json` drops the workspace dep, adds
`@cloudflare/worker-bundler`, `@cloudflare/workers-oauth-provider`, `yjs`, `tsx`, `undici`, and removes
the `bench` script.

**3.6 Three doctrine inversions.** (i) *Unreadable rows*: v3 reports-and-skips ("must not brick the context
on every wake"); v4's `STREAM_RESOURCE_HALTED` is a durable latch refusing every public door until an
operator repairs the row. (ii) *Pipelining*: `IterateContext.invoke` became `async` and awaits the DO before
returning, retiring the edge's native RPC promise — the thing the mid-chain-pipelining work preserves.
(iii) *Egress*: the DO's `fetch` now defaults the expression to `"itx"` when no header is present, so
ordinary requests route through the rewrite rules instead of straight to the terminal.

## 4. Effort to backport the fixes

Measured against v4's implementations (code lines, non-blank non-comment). At v3's density — ~300 code lines
with tests, docs and a deployed proof in ~3 h — this is **two sittings**, and it is not one commit.

| # | Fix | Code lines | Hours (code + test + deployed proof) |
|---|---|---|---|
| 2.1 | `reduceBatch` + draft tables | 32 | 1.5 (the pin already exists — flip `test.fails` → `test`) |
| 2.2 | SDK `using` release | 16 | 1.0 (deployed facet memory probe) |
| 2.3 | Halt dedupe + row identity | 49 | 2.5 (three unit pins; one deployed) |
| 2.4 | Reserve `core` at the door | 12 | 0.5 |
| 2.5 | Wake-fan-out gate | 20–35 | 3.0 (needs a deployed wake-count probe first — §6 Q1) |
| 2.6 | Lease semantics | 23 | 1.5 (re-provide/dispose-old e2e) |
| 2.7 | DO stub generation | 13 | 0.5 |
| 2.8 | DO-reset log classification | 21 | 0.5 |
| 2.9 | JSON loaderId | 1 | 0.5 (loader-cache flag day) |
| 2.10 | Library hygiene ×4 | 24 | 1.0 |
| — | `directRpcStubKey` dedup (§1) | −12 net | 0.5 |
| | **Total** | **≈ 200 net** | **≈ 13 h** |

Recommended split (small-PRs rule): **A** = 2.1 + 2.2 + 2.4 (memory/correctness core, ~60 lines, flips one
red pin) · **B** = 2.3 + 2.6 + 2.7 (delivery and lease lifetimes, ~85 lines) · **C** = 2.8 + 2.9 + 2.10 + the
dedup (hygiene, ~35 lines). **2.5 is an investigation, not a PR yet.**

## 5. Dependencies

- **Nothing here needs new infra.** No binding, DNS, secret or control-plane change: every fix is inside
  `packages/v3/project-worker/src`. (v4's *features* need `BUNDLER`, `SECRETS_KV`, `EGRESS_KEY`,
  `EXPERIMENT_ADMIN_TOKEN`, `PUBLIC_ORIGIN`, `APP_CONFIG_PROJECTS_JSON` — not in scope here.)
- **2.1 lands before any further core-state growth work** — it is the difference between a version bump being
  a 25 s reboot loop and a sub-second rebuild.
- **2.3 touches the file the two reverted perf commits churned** — land on `e38f787e4` and re-run the
  ephemeral fan-out proof after: it changes which pushes reach a halted row.
- **2.5 is sequenced after a measurement**, never before. **2.9 is a loader-cache flag day** — land it alone.
- **Independent:** 2.2, 2.4, 2.7, 2.8, 2.10. **Blocked by a decision, not code:** `invoke`'s promise (§3.6 ii)
  and the MCP SDK (§3.4).
- **What this unblocks:** 2.1 + 2.2 remove two of the three remaining `test.fails` in
  `stream/memory-budget.test.ts` — the gate d3's memory arc is measured against.

## 6. Risks and questions for Jonas

**Q1 — the wake loop (§2.5) is my inference, not a proof.** From v3's `alarm()` + `onCommit` I believe an
evicted context with a cursor subscription re-wakes every 60 s forever, writing a `stream/woken` row each
time. I did not measure it. Do you want a deployed wake-count probe on a live context with a Worker-Loader
cursor target before anyone writes the fix?

**Q2 — should a DO reset be demoted from `event:"issue"` to `console.info` (§2.8)?** It de-noises the logs,
and it hides exactly the signal d3 is hunting. My recommendation: take the *classification* (the three
platform flags, read once, safely) but keep it at `console.error` with a distinct `event` name, so the reset
stays greppable.

**Q3 — the MCP SDK (§3.4).** v4 replaced 174 lines of first-party JSON-RPC with `@modelcontextprotocol/sdk`
and widened the library boundary test to admit it. That buys protocol negotiation and correct session/SSE
handling; it costs edge/DO script size right after you paid to delete zod for 11 ms of startup (I must not
build v4, so I could not measure it). Is the library tier allowed npm dependencies at all — is "takes only
`itx`" also "imports only `itx`"?

**Q4 — `awaitAndReleaseInertRpcResult` (61 lines of descriptor-walking in `iterate-context.ts`).** It solves a
real problem you already have a memory note about (RPC results pin the callee until disposed). But it is a
defensive graph proof against a *trusted* client, and it makes `invoke` `async`, retiring the edge's native
RPC promise (§3.6 ii). My recommendation: take 2.2 (the narrow, provably-inert SDK case, 16 lines) and leave
this one. Do you agree, or do you want the general case?

**Q5 — content hash: v4 replaced v3's memoised djb2 with an uncached SHA-256 (`context/worker-loader.ts`).**
v4's argument is real: a 32-bit hash keyed on *object identity* reuses a stale digest if a caller mutates a
modules record, and it can collide into the wrong isolate. v3's argument is also real and measured
(`a71cfad12`: a warm facet push must not re-hash its source on every commit). Neither tree has both. The
obvious answer is to memoise the SHA — but the WeakMap-by-identity memo is exactly what v4 calls unsound.
Which risk do you want to hold?

**Q6 — v4's `worker.ts` rewrites the request URL from the `Host` header** for a local-harness reason,
re-creating every request — WebSocket upgrades included — on the hottest path in the tree. I would not carry
it into v3.

**Q7 — v4 is a *fork*, not a branch, and it has drifted 10 commits.** Someone has to decide whether v4
rebases onto v3 (inheriting ingress, identity, the read-admission ceiling, the live-state ordering fix) or
whether v3 harvests v4 by hand. edge#10 was found and fixed twice, independently: that is the cost of the
fork, and it compounds.

**Two v4 assertions I could not verify:** that a `DurableObjectStub` is poisoned by DO-thrown exceptions
(§2.7), and every deployment claim in `packages/v4/project-worker/README.md` — I read the source, not the
deployed worker.
