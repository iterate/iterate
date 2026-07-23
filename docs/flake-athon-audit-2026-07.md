# Flake-athon audit (2026-07-21 → 2026-07-23)

An adversarial review of the ~32 PRs a coding agent merged into `main` over two
days as a "flake-athon" — a campaign to drive CI/e2e flakiness to zero. The
brief was to separate the genuinely-good root-cause fixes from changes that
**traded real robustness for a green CI**: deleted guards that were added for
valid reasons, masked races, weakened assertions, widened timeouts, or reduced
coverage.

Every claim below is judged against the repo's own written policy in
[`docs/testing.md`](testing.md#retries-and-timeouts) — the six principles and
the timeout ladder — and verified against the merged source at HEAD, not the PR
prose. Two independent audits were run in parallel (a Claude subagent fan-out
across four PR clusters, and a Codex `gpt-5.6-sol` xhigh pass); their
convergences and one disagreement are noted in
[§ Cross-check](#cross-check-two-independent-audits).

---

## TL;DR

**The flake-athon is, overwhelmingly, good work.** The great majority of these
PRs fix real root causes — bounded, error-class-scoped recoveries; genuine
product fixes with `data-spinner` states; coverage that _increased_; a telemetry
rework that is fail-closed in exactly the right places. The "big deletion =
deleted guard" heuristic mostly misfires: the -1,297 / -1,059 / -319 diffs are
dominated by moved code, completed-task-file cleanup, and doc churn.

The rollout race (#1) is the largest single issue, but the Codex cross-check
showed the risk is **somewhat more distributed than a first pass suggests** —
two changes rated GOOD by the Claude fan-out are downgraded below with verified
external evidence (**B2** #2266 retries `overloaded` against Cloudflare guidance;
**B4** #2227 reversed a measured concurrency ceiling on one run). The headline
findings:

| #     | Severity    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status at HEAD              |
| ----- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **1** | 🔴 **High** | **#2261** deleted the cross-lane Durable-Object rollout barrier (added deliberately one day earlier in **#2140**) with no replacement; **#2265** later restored it as a _blind fixed 90 s sleep_ (`previewMinimumDeploymentAgeMs`). The race is gated again, but by an **unprovable time constant that is off the guarded ladder, with no tracking task**. The DO-reset flake is still being **retry-absorbed** (visible in #2244's own marathon: accepted streak = 0). | Gated but fragile           |
| **2** | 🟠 Medium   | **#2265** the 90 s rollout gate is a CI-critical-path timing constant that lives **outside `budgets.ts`** and is not covered by the `e2e-policy.test.ts` ordering guard — the one discipline the policy says every e2e number must follow. It also runtime-extends the guarded 90 s Playwright spec budget to ~180 s.                                                                                                                                                   | Works, drifts unaudited     |
| **3** | 🟡 Low-Med  | **#2253** widened a cross-post `waitForEvent` **30 s → 100 s** to absorb a cold project-worker delivery tail. Policy-compliant in _form_ (carries a `// comment`, cites two 30 s breaches, points at `tasks/reduce-project-worker-cross-post-tail.md` with a restore-to-30 s exit) but it is still tail-masking, and 100 s is a large single wait.                                                                                                                      | Tracked; verify it restores |
| **4** | 🟡 Low      | **#2226** briefly put PostHog delivery on the **"Run Tests" critical path** (`TEST_TELEMETRY_ENABLED=1`), so a telemetry outage could fail a green PR. **#2237 removed it entirely** (grep-clean at HEAD). No residue — but nothing stops it being reintroduced.                                                                                                                                                                                                        | Fixed; add a guard          |
| 5     | 🟢 Nit      | **#2253** quarantined the live-capability WebSocket-mesh e2e (real coverage debt, but honestly booked via the protocol with a named task). **#2271 / #2273** introduce one wedged-teardown re-poke path and one bounded create-read poll with **no telemetry counter**, so a future regression hides as absorbed latency rather than surfacing as data.                                                                                                                 | Acceptable; observe         |

Nothing in the runtime-stability cluster (streams, wake, sandbox, worker-build:
#2271, #2257, #2256, #2252, #2270, #2269, #2240, #2230) masks a race. Every new
wait/retry there is bounded and scoped to the right error class; the two changes
most capable of hiding an ordering bug (#2271's removal of pulled-result
liveness, #2269's removal of a pre-wait `catchUp`) are each _replaced by a
stronger invariant_, verified in source. **The two exceptions the Codex pass
caught** — #2266 looping on `overloaded` (B2) and #2251 stranding a queued build
after alarm-retry exhaustion (U1) — are not ordering-race masks but a wrong
error contract and a missing terminal state respectively; both are in the
cross-check ledger below with fixes.

---

## 1 · 🔴 The one real robustness-for-green trade: the DO rollout barrier (#2261 → #2265)

This is the finding that justifies Jonas's suspicion, and it is worth
understanding precisely because the story spans three PRs across the two days.

### What happened, in order

1. **#2140** (2026-07-21, "Run preview deploys and e2e at full concurrency")
   introduced `apps/os/src/deployment-readiness.ts` — a readiness barrier that
   ran **inside the deploy step**, gating the deploy→`awaiting-tests` transition
   that **every** test lane (Vitest _and_ Playwright) waited behind. It probed
   each DO namespace in ~10 waves, dwelt 10 s for stability, then revalidated
   the complete set. Its stated reason, verbatim from the PR: _"prevent tests
   from starting inside the Durable Object reset window observed on earlier
   runs."_ This is a real, named failure mode: when a new Worker version
   deploys, the first access to each Durable Object triggers Cloudflare to reset
   that DO to load the new code, surfacing as
   `Durable Object reset because its code was updated`.

2. **#2261** (2026-07-22, "Remove synthetic Durable Object rollout probes",
   +151 / **−1297**) deleted that barrier wholesale. The critique in its body is
   _partly fair_: a finite synthetic probe sample can't prove the whole fleet is
   settled, and ~500 probe RPCs per deploy dominated the tail cost. But it
   replaced a cross-lane barrier with only an onboarding-smoke gate in front of
   **Vitest**, and its own round-9 marathon evidence (added to
   `docs/preview-e2e-flake-hunt.md` in the same PR) shows the reset race
   **recurring and being retry-absorbed** — 7 Vitest + 2 Playwright tests
   passing only on their single retry, and `OS preview smoke` failing _both_
   attempts. No `tasks/` quarantine was filed for the residual race. Under the
   policy this is the textbook violation: _"Never hide it with … an extra
   retry,"_ and step 3 of the quarantine protocol (a named tracking task) was
   skipped.

3. **#2265** (2026-07-23, "Stabilize preview e2e across Durable Object
   rollouts") quietly restored a barrier — but as a **blind, fixed-duration age
   gate**: `previewMinimumDeploymentAgeMs = 90_000`
   (`scripts/preview/preview.ts:74`). DO-backed suites and every project-create
   helper now wait until 90 s after the deploy timestamp
   (`resolvePreviewRolloutReadyAtMs`, `preview.ts:850`), via
   `PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV` for Playwright's per-spec waits and a
   `rollout-settle` sleep lane for Vitest (`preview.ts:2272-2279`).

### Why the end state is still not right

At HEAD the race _is_ gated for both lanes — so this is not an open production
hole — but the gate has three problems the original barrier did not:

- **It is a blind sleep, not a proof.** The old barrier _checked_ readiness; the
  new one _hopes_ 90 s ≥ the reset-settle window. If the window ever exceeds
  90 s (a slow rollout, a busy edge), the race silently returns and is absorbed
  by the one retry — exactly the failure the marathon already shows. This is the
  "sleep through it instead of proving the state" anti-pattern the policy warns
  against (principle 4), just relocated from the test into the orchestrator.
- **It taxes every healthy run.** A fixed 90 s is paid in full even when the
  rollout settled in 15 s. The old barrier released as soon as the fleet was
  actually ready.
- **It is off the guarded ladder and untracked.** See finding #2.

### The cleaner, provable refactor

Replace the blind age gate with a **cheap active readiness gate** that checks the
actual invariant — "the new version is serving _and_ each DO namespace the tests
will touch has completed its post-deploy reset" — bounded by a watchdog and
sourced from `budgets.ts`. This keeps #2261's correct instinct (drop the 500
synthetic probes) while restoring #2140's provability:

- One readiness request **per DO namespace class the suite actually uses** (a
  handful, not 500 fleet-wide synthetic probes), issued once, that _forces and
  confirms_ the reset ahead of the tests. The reset is idempotent and one-shot
  per version, so a single touch per namespace is sufficient — that is what
  makes it provable rather than probabilistic.
- Gate returns the moment all namespaces answer post-reset; a
  `PREVIEW_ROLLOUT_READINESS_WATCHDOG_MS` backstop (on the ladder, sized ~2× the
  measured p99 settle) fails the run if they don't — a wedged rollout _should_
  fail, per principle 3.
- Both lanes wait on the same gate (Vitest at its fan-out boundary, Playwright's
  project-create helpers on the same ready signal), so neither races.

Sketch (illustrative — see §7 for the exact `budgets.ts`/guard diff that is
safe to land now):

```ts
// scripts/preview/preview.ts — replaces the fixed-age readyAt computation
async function awaitPreviewRolloutReady(app, deployedWorkerVersion, signal) {
  const deadline = Date.now() + PREVIEW_ROLLOUT_READINESS_WATCHDOG_MS;
  for (const namespace of app.rolloutReadinessNamespaces) {
    // one real request that forces + confirms the post-deploy DO reset;
    // retry ONLY on `durableObjectReset`/`overloaded` until the version served
    // matches deployedWorkerVersion, then move on. Never sleeps a fixed span.
    await probeUntilServingNewVersion({ namespace, deployedWorkerVersion, deadline, signal });
  }
}
```

Until that lands, the _minimum_ to make the current state honest is finding #1's
two-line follow-up: **(a)** move the constant onto the ladder (finding #2), and
**(b)** file the tracking task — done in this PR as
[`tasks/preview-rollout-do-reset-gate.md`](../tasks/preview-rollout-do-reset-gate.md),
which records the residual retry-absorption evidence and a **zero-retry exit
criterion** so the debt is visible instead of silent.

---

## 2 · 🟠 The rollout gate is off the guarded ladder (#2265)

`docs/testing.md` is emphatic: _"The constants live in
`packages/shared/src/test-support/e2e-policy/budgets.ts` (one file, every config
imports it) and `scripts/preview/e2e-policy.test.ts` guards the invariants."_
`previewMinimumDeploymentAgeMs` is a CI-critical-path timing constant that
governs when tests may start — and it lives as a bare literal in
`scripts/preview/preview.ts:74`, imported by nothing, guarded by nothing in the
ladder test.

It also **runtime-extends a guarded budget**: `email-otp-signup.ts:62` and
`forged-session.ts` do `testInfo.setTimeout(testInfo.timeout + waitMs)`, growing
the guarded 90 s `SPEC_TEST_TIMEOUT_MS` toward ~180 s during a rollout. That is
defensible (the spec genuinely needs the extra time _only_ while waiting on the
platform, and it's bounded), but it means the guarded spec budget is silently
supplemented off-ladder — a reader auditing `budgets.ts` would never know.

`PREVIEW_RUN_PROOF_BUDGET_SECS` already sets the precedent: it lives in
`budgets.ts` with a comment explaining it is deliberately _not_ part of the
ordered watchdog ladder. The rollout-age gate should sit right next to it. See
§7 for the exact, safe-to-land diff.

---

## 3 · 🟡 The one genuine timeout-widen (#2253)

`itx-agents.e2e.test.ts:771` — the cross-post `waitForEvent` budget went
**30 s → 100 s**. This is the only "widen the wait instead of fix the product"
in the whole flake-athon. In its favour, it is the _policy-compliant_ form:

- carries the required `// comment` naming why,
- cites two concrete runs that blew the old 30 s,
- is explicitly temporary with a **restore-to-30 s exit criterion**, and
- points at `tasks/reduce-project-worker-cross-post-tail.md` for the real fix
  (a cold project-worker delivery tail).

But 100 s is a large single wait and it _is_ masking a real latency tail. The
action item is simply to **make sure the task lands and restores 30 s**, rather
than letting 100 s calcify into a permanent vibe budget. A telemetry counter on
the actual observed cross-post latency (so the tail is visible as data) would
let the restore be evidence-driven.

---

## 4 · 🟡 Telemetry on the critical path — introduced then removed (#2226 → #2237)

**#2226** shipped the telemetry foundation with PostHog delivery _inside_ the
test reporter, and set `TEST_TELEMETRY_ENABLED=1` on the **"Run Tests"** step
itself. The reporter _"fails the command on missing config or delivery errors"_
— so a PostHog outage or a key misconfig could fail an otherwise-green PR. It
also inherited the wrong PostHog project (a dev key vs the `_shared/prd`
dashboards), a silent dataset split.

**#2237** fixed both, and did so well: reporters became pure artifact producers
with **zero network I/O** (verified: grep of all three reporters is empty), the
finalizer moved to a separate `if: always()` step under `_shared/prd` that can
only _add_ a telemetry-completeness failure — never mask a red test or invent a
green one — and `TEST_TELEMETRY_EXPECTED_WORKSPACES` is wired so a workspace
that silently emits **nothing** fails the finalizer (the list equals exactly the
10 packages with a `test` script). Every fail-closed path has a dedicated
regression test.

No residue remains (`grep TEST_TELEMETRY_ENABLED` is clean). The only gap is
that nothing _prevents_ the regression from returning. Recommended: a one-line
guard in `depot-workflows.test.ts` asserting **no test-run step re-introduces
in-band telemetry delivery** (`TEST_TELEMETRY_ENABLED` or a PostHog key on a
`Run Tests` step). Sketch in §7.

---

## 5 · The GOOD (the majority — keep these)

Verified root-cause fixes and clean refactors. These are the flake-athon working
as intended:

**Runtime stability (all verified bounded & error-scoped):**

- **#2271** "Decouple wake delivery settlement" — removes the cyclic
  pulled-result-as-liveness coupling; a wake **cannot** be reported delivered
  before it's processed, because settlement is reported strictly _after_ the
  durable attempt, silent wedges are caught by the idle-teardown watchdog that
  re-pokes from the durable checkpoint, and transport breaks fail closed via
  `onRpcBroken`. The invariant is _stronger_ than before (settlement carries a
  real ok/error verdict). Fully backstopped in source.
- **#2266** "Recover processor waits across transient DO overload" — a _bounded_
  retry, gated on `isRetryableDurableObjectAvailabilityError` only (application
  errors throw immediately, proven by test), ceiling = the caller's public
  deadline, 1 s backoff cap. Correct at-least-once recovery, not a mask.
- **#2273** "Avoid Artifacts create-read race" — removes the create-then-read
  race on the happy path by reusing the write token `create()` already minted;
  the `waitForExistingArtifact` poll retries **only** repo-not-seeded lifecycle
  codes (infra errors propagate immediately, proven by test), bounded 45 s.
- **#2269** "Stabilize preview project creation" — removes a pre-wait
  `registry.catchUp` in four DOs. Archaeology confirms this removes a _weaker,
  unbounded, failure-swallowing_ path (the old scheduler comment literally said
  "catchUp swallows failures by design") in favour of the offset
  `waitUntilEvent` self-pull, which treats a failed pull as **authoritative**
  and bounds it. Strengthens the failure contract.
- **#2240** "Fix ITX script recovery across DO resets" — relocates the runScript
  waiter onto the stateless RPC boundary so a _successor_ incarnation's
  settlement is observed instead of dying with the orphaned RPC. Idempotent,
  bounded, no swallow.
- **#2257** (vendored verbatim Cloudflare upstream fix, lifetime bounded by the
  RPC promise settling), **#2256 / #2251 / #2252** (real build-key CAS/durable-
  handoff coordination keyed by SHA-256, not polls), **#2270** (test-only,
  removes a genuine readback race), **#2230** (presentational "waiting" state,
  mis-bucketed as flake but harmless). All GOOD.

**Deletion-heavy PRs that are _not_ deleted guards:**

- **#2217** (−1059) — dominated by `tasks/complete/*` cleanup and docs; product
  code is net-additive with new coordinator tests; the −72 in `worker-loader.ts`
  is _moved_, not deleted.
- **#2244** (−319) — makes the marathon _stricter_ (rejects any absorbed retry;
  old loop counted retry-absorbed runs as green) and retires genuine masking
  layers (uncounted warmup runs). Its own evidence honestly shows streak = 0.
- **#2215** (−129) — coverage-_preserving_ refactor that _adds_ a pinning test
  for a previously-accidental invariant (unconsumed revival facts → eventless
  caught-up delivery), verified in `stream-subscribers.ts`.
- **#2239**, **#2242** — real deploy-blocker / fail-fast fixes with tests;
  #2239 does _not_ touch the Artifacts quarantine (that predates it in #2146).

**Orchestration & coverage:**

- **#2263** "Run preview e2e on every triggered PR head" — coverage-_increasing_:
  drops a `headSha` gate that let non-app diffs skip testing and replaces two
  silent-green `skipped` exits with fail-closed `throw`s.
- **#2227 / #2268** — parallelism knobs (7→64 e2e file workers; 8→16 Playwright),
  both with verified per-test project isolation (unique slugs), #2268 carrying
  the required `// comment` + evidence. No shared-state collision.
- **#2241** "Shrink the slow suspend recovery e2e" — the title undersells it:
  it _removes_ ~50 s of dead `waitForTimeout` sleeps and **adds** assertions
  (replaces an ineffective `setWebLifecycleState` that never actually suspended
  timers with `Emulation.setScriptExecutionDisabled` + a timer-gap probe that
  now _asserts_ suspension). Coverage went up, not down.
- **#2236** (additive diagnostic command, not on the CI critical path),
  **#2267** (baked-workspace boot, infra-only), **#2235 / #2238** (strict
  small e2e correctness fixes), **#2232** (docs-only evidence ledger),
  **#2254 / #2243** (pure-observation deploy-phase timing; Doppler creds that
  fail closed in CI). All GOOD.

---

## 6 · Hardening / observability nits

- **#2271**: the wedged-teardown re-poke path is only a `warn`. Add a telemetry
  counter so the watchdog firing is visible in prod as data.
- **#2273**: `waitForExistingArtifact` absorbs create-read latency inside its
  45 s bound. Add a retry-count/elapsed counter so a _widening_ Artifacts
  replication window surfaces as a trend, not as silently-absorbed latency. Add
  a one-line comment reconciling the 45 s repo poll with the 15 s project-create
  deadline (two different callers — coherent, but non-obvious).
- **#2253**: the quarantined live-capability WebSocket-mesh e2e is real coverage
  debt (the Node→worker-mesh WebSocket boundary is no longer proven). Correctly
  booked via `tasks/quarantined-live-capability-websocket-e2e.md`; keep it on
  the radar until that task closes.

---

## 7 · Concrete, safe-to-land follow-ups

These are ordered by value ÷ risk. Items A–C are self-contained and provably
correct; item D is the larger refactor that needs a Depot CI validation run
before landing (which is why this PR _documents_ it rather than applying it — the
audit was produced off-CI and unvalidated CI-orchestration edits are exactly the
kind of change that should not be merged blind).

### A. Put the rollout-age gate on the guarded ladder (fixes finding #2)

Add to `packages/shared/src/test-support/e2e-policy/budgets.ts`, next to
`PREVIEW_RUN_PROOF_BUDGET_SECS`:

```ts
/**
 * Minimum age of a fresh preview deployment before DO-backed suites and
 * project-create helpers may run against it. After a new Worker version
 * deploys, the first access to each Durable Object triggers a code-update
 * reset; starting tests inside that window surfaces as
 * `Durable Object reset because its code was updated`. Like
 * PREVIEW_RUN_PROOF_BUDGET_SECS this is NOT part of the ordered watchdog
 * ladder — it is a platform eventual-consistency backstop. Reused (old)
 * deployments wait zero. Blind-fixed today; tasks/preview-rollout-do-reset-gate.md
 * tracks replacing it with an active readiness probe.
 */
export const PREVIEW_MINIMUM_DEPLOYMENT_AGE_MS = 90_000;
```

Then in `scripts/preview/preview.ts` replace the bare literal at line 74 with an
import of `PREVIEW_MINIMUM_DEPLOYMENT_AGE_MS`, and in
`scripts/preview/e2e-policy.test.ts` add an assertion that `preview.ts` sources
this constant from `budgets.ts` (mirroring the existing shell-sync guards), so
it can't drift back into an unguarded literal.

### B. Guard against telemetry returning to the critical path (fixes finding #4)

In `apps/os/.../depot-workflows.test.ts` (wherever the workflow YAML is already
asserted), add:

```ts
it("no test-run step performs in-band telemetry delivery", () => {
  // #2226 regressed by setting TEST_TELEMETRY_ENABLED on the Run Tests step,
  // putting PostHog delivery on the pass/fail critical path. #2237 removed it.
  // Delivery belongs only in the separate if:always() finalizer step.
  const testStep = runTestsStep(testWorkflow);
  expect(JSON.stringify(testStep)).not.toMatch(/TEST_TELEMETRY_ENABLED/);
});
```

### C. File the missing tracking task (fixes finding #1's protocol gap)

Done in this PR: [`tasks/preview-rollout-do-reset-gate.md`](../tasks/preview-rollout-do-reset-gate.md).

### D. The real fix for #1 — make the operation self-heal, delete the gate

> **Superseded design note.** An earlier draft of this section proposed a _cheap
> active readiness probe_ (one touch per DO namespace class). The Codex
> cross-check refuted it: Cloudflare DO rollout is **globally eventually
> consistent per object/placement**, so probing identity A does not prove a
> future test identity B (different placement) has converged — #2140 used many
> identities precisely because one is insufficient. **No gate or probe can prove
> convergence.** The sound fix is operations that survive a reset whenever/wherever
> it lands. Full candidate comparison + recommendation:
> [`docs/flake-athon-refactor-options.md`](flake-athon-refactor-options.md).

The recommended shape: (1) split the availability classifier so `overloaded` is
never retried (finding B2); (2) finish the create saga's self-heal — one
`waitForEvent` branch re-arms on reset like `waitUntilProcessed` already does;
(3) model `create()`'s outcome explicitly instead of the ambiguous 15 s reject
(finding B3); (4) consolidate to one canonical fixture; (5) delete the blind gate
and plumbing; (6) replace it with a post-deploy recovery **canary** (proof, not a
sleep). Land behind a Depot CI validation run. Definition of done: the
`flake-hunt-loop.sh` marathon reaches the **25-consecutive-zero-retry** bar
(finding B5) with no `Durable Object reset because its code was updated` in any
first attempt — the exit criterion recorded in the task file.

---

## Cross-check: two independent audits

This report is the reconciliation of two independent passes:

- **Claude subagent fan-out** — four agents, one per PR cluster (deletion
  suspects / preview-e2e orchestration / runtime stability / telemetry infra),
  each doing its own `gh` + git archaeology against HEAD.
- **Codex `gpt-5.6-sol`, xhigh effort** — an independent full pass over the same
  PR set. _(Codex findings folded in below.)_

**Where they converged** (high confidence): #2261 as the single real
robustness-for-green trade; the deletion-count heuristic over-flagging #2217 /
#2244 / #2215; the runtime-stability cluster being genuinely well-built with no
masked race; #2237's telemetry contract being fail-closed and honest.

**Where the two Claude clusters refined each other** (the important nuance): the
deletion-cluster agent read #2261 in isolation and called Playwright "ungated";
the orchestration agent, looking at HEAD, found Playwright _is_ gated per-spec by
#2265's later age constant. The synthesis in §1 — _#2261 opened the gap, #2265
closed it as a blind sleep_ — is more accurate than either agent alone and is
the reason this audit reads the three PRs as one story.

**Codex cross-check — where it went further than the Claude fan-out.** Codex
independently confirmed #2261/#2265 as the headline, and the deletion-heuristic
misfires. It also surfaced **four substantive findings the Claude clusters rated
GOOD but Codex downgrades with external evidence — all verified against source**:

- **B2 · #2266 retries `overloaded` (HIGH).** `isDurableObjectLifecycleError`
  (`stream-unavailable.ts:38-45`) collapses `durableObjectReset | overloaded |
retryable` into one boolean, and #2266 loops on it to the deadline. Cloudflare
  says overload must **not** be retried (it worsens the overload). Under the
  campaign's 48-file + 16-worker fan-out this is a synchronized retry storm that
  hides the capacity signal. Fix: discriminate `reset|retryable|overloaded` and
  propagate overload as typed backpressure. _(The Claude cluster-C pass called
  #2266 "bounded and fine" — true for reset, wrong for overload.)_
- **B3 · #2273 ambiguous create-success (HIGH).** Default `create()` rejects at
  ~15 s while a 75 s birth drive keeps committing (`rpc-targets.ts:5200-5205,
5308-5343`), so a caller can get an _error_ for a project that durably succeeds
  and later becomes ready — an unmodelled outcome that leans on a caller/test
  redial. Fix: split the acknowledgement boundaries (see the refactor doc).
- **B4 · #2227 concurrency reversal is unproven (BAD/RISK).** #2169 — the PR
  immediately before — kept **7** Vitest file workers because a 64-worker
  experiment made remote project bootstrap "substantially slower and less
  reliable" (remote capacity, not runner CPU, was the ceiling). #2227 reversed it
  to ~48 on **one** retrying run, violating the documented "≥3 unchanged runs
  before a concurrency change" rule (`docs/ci-preview-performance.md:152-154`).
  The 48+16 burst is the environment in which the later overload/create-tail
  findings appear.
- **B5 · the campaign never met its own bar.** The release proof is 25
  consecutive zero-retry runs (`ci-preview-performance.md:156-169`); the accepted
  runs for #2253/#2261/#2265/#2266/#2273 each still carried retries (streak
  0/25). Green under the one-retry policy ≠ "flake-athon proven."
- **U1 · #2251 can strand a queued build** after native alarm-retry exhaustion
  (no durable `stalled`/`failed` terminal state) — a latent leak, not a flake.

And the **decisive correction to this audit's own §7-D**: the active-probe idea
is not provably correct under eventual consistency; the sound answer is
self-healing operations + a post-deploy canary. That correction reshaped the
recommendation in
[`docs/flake-athon-refactor-options.md`](flake-athon-refactor-options.md) — the
strongest single argument for running the two audits in parallel.
