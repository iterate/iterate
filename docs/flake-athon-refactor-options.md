# Refactor options: project creation & e2e fixtures (flake-athon follow-up)

The [audit](flake-athon-audit-2026-07.md) found the one real robustness-for-green
trade is the preview Durable-Object rollout race, currently gated by a **blind
90 s sleep** (`previewMinimumDeploymentAgeMs`) that is off the guarded ladder and
unprovable. This doc explores four candidate refactors that address it by
improving **project creation** and the **e2e test fixtures**, and recommends one.

Four candidate designs were each prototyped independently against the real code
(by parallel Claude subagents), and a Codex `gpt-5.6-sol` xhigh pass audited the
same surface. The candidates and the evidence that decided between them:

## TL;DR — the minimal fix (measured net −277 LOC, less complexity, more robust)

The first draft of this doc grew a 7-step plan. That was over-built. Re-examined
for _smallest change / least complexity / most robustness_ — grounded in
Cloudflare's own docs, and with the patch **actually applied and validated in an
isolated worktree** (codex `gpt-5.6-sol`: 45/45 apps/os focused tests, 148/148
preview-workflow tests, `pnpm typecheck`, and `git diff --check` all pass) — the
answer is **two changes, one of them a pure deletion, for a measured net −277
LOC** (43 added / 320 deleted):

1. **Delete the entire rollout gate and its plumbing — 305 lines removed, ~17
   added** (the additions are just formatter collapse where fields/branches were
   removed; no replacement mechanism). This is not just cleanup: **Cloudflare
   documents no way to wait for a rollout to become globally consistent.** DO code
   propagation is eventually consistent and a new Worker calls old-version DOs
   "for seconds to minutes"
   ([known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates));
   the _only_ supported remedy is forward/backward-compatible code — "design for
   skew." A time/probe gate is categorically the wrong tool, so the whole
   subsystem goes: `preview-rollout-gate.ts` (+ its test, −120), the
   `previewMinimumDeploymentAgeMs` constant, the timestamp resolvers, the
   before/inside-suite gates, the rollout-settle lane and env injection in
   `preview.ts` (−89), the `previewTestRolloutGate` config field, the per-spec
   `testInfo.setTimeout` extensions, and the rollout-timeout argument plumbing
   threaded through the specs.

2. **Close the one real gap by _reusing_ the existing one-retry helper — +12 / −7
   in `rpc-targets.ts`.** `create()`'s `project/ready` wait resolves through
   `waitUntilReady()` → `waitForEvent({ afterOffset: 0 })`, and the **single
   native stub call at `rpc-targets.ts:681-689` is the only operation on the
   create leg that still turns a first-touch reset into a terminal
   `stream-unavailable` error** (everything else already self-heals). Rather than
   add new re-arm branches, wrap that one call in the **existing**
   `retryLoggedIdempotentOperation` helper — which already gives exactly one
   retry, a **fresh stub** each attempt (the `durableObjectStub` getter re-calls
   `getByName`), and an observable log. It's a read-only observation replayed from
   the same pinned `afterOffset`, so a ready event committed before the reset is
   replayed, not skipped; a second consecutive availability failure and every
   application error stay terminal. This matches Cloudflare's blessed shape
   exactly (bounded, fresh stub, retry only the retryable class) — and it also
   requires flipping the existing test at
   `stream-processor-rpc-target.test.ts:390-411`, which currently _freezes_ the
   terminal-reset behavior, into a fresh-stub recovery proof.

Everything else in the create saga already self-heals (keyed-append retry,
processor-relay retry); this closes the single path that still surfaces a reset.
**Net effect: delete a whole subsystem, add ~16 lines of product code, and the
reset is absorbed in-process wherever eventual consistency lands it — at 1 s,
91 s, or during an ordinary production create — instead of slept through and
hoped.** Strictly more robust _and_ strictly less code, validated at the
unit/typecheck level (the live preview marathon is the remaining check).

Because the new retry sees the raw workerd exception, it **must not** retry
overload — so the same change carries a **one-line guard in the existing boolean
classifier** (`stream-unavailable.ts:38-45`), no new type or wire contract:

```ts
// isDurableObjectLifecycleError — exclude overload (Cloudflare: never retry it)
return flags.overloaded !== true && (flags.durableObjectReset === true || flags.retryable === true);
```

**Two small, separable hardening fixes** (real per Cloudflare, but independent of
the gate deletion — do them as their own tiny PRs, _not_ a precondition):

- **The broader `overloaded` story (audit finding B2).** The one-line guard above
  fixes the raw-error path this change touches; the _full_ taxonomy (an
  `overloaded` that already crossed capnweb as a `stream-unavailable:` string and
  lost its flags, retried by `waitUntilProcessed`'s deadline loop) is a separable
  B2 hardening — it does **not** need a discriminated-union classifier refactor to
  land this fix. Cloudflare is explicit: `.overloaded` "should not be retried…
  retrying will worsen the overload"
  ([error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)).
- **Match the blessed retry cadence.** `waitUntilProcessed`'s ~1 Hz deadline-loop
  drifts from Cloudflare's "exponential backoff + jitter, small attempt cap."
  Minor; align when touching it.

**Cut from the first draft as not load-bearing** for deleting the gate: the
explicit-`create()`-contract change (#2273/B3 — orthogonal ambiguous-success
concern), the post-deploy canary (the marathon already _is_ the evidence), the
fixture consolidation (good hygiene, optional), and the concurrency sweep (B4 —
its own operational task). The active-readiness probe (C4) is not merely cut but
**refuted** — Cloudflare confirms no convergence gate can exist.

### The measured patch (applied + validated in a throwaway worktree)

| File                                                                |   +add |    −del | Purpose                                                                                         |
| ------------------------------------------------------------------- | -----: | ------: | ----------------------------------------------------------------------------------------------- |
| `apps/os/src/rpc-targets.ts`                                        |     12 |       7 | Run the native `waitForEvent` through the existing logged one-retry helper                      |
| `apps/os/src/domains/streams/stream-unavailable.ts`                 |      4 |       2 | Exclude raw overload from reset/retryable classification                                        |
| `apps/os/src/domains/streams/stream-unavailable.test.ts`            |      1 |       1 | Assert raw overload is not lifecycle-retryable                                                  |
| `apps/os/src/domains/streams/stream-processor-rpc-target.test.ts`   |      9 |       5 | Flip the terminal-reset test into a fresh-stub recovery proof                                   |
| `apps/os/e2e/vitest/onboarding-smoke.ts`                            |      0 |       6 | Remove rollout-wait import/use                                                                  |
| `packages/shared/src/test-support/preview-rollout-gate.ts` (+ test) |      0 |     120 | Delete the gate implementation + its tests                                                      |
| `packages/shared/package.json`                                      |      0 |       1 | Remove gate export                                                                              |
| `scripts/preview/preview.ts`                                        |      4 |      89 | Remove constant, resolvers, config field, before/inside-suite gates, env injection, settle lane |
| `scripts/preview/preview.test.ts`                                   |      3 |      59 | Remove resolver/config/lane tests                                                               |
| `scripts/preview/e2e-policy.test.ts`                                |      1 |       4 | Remove the rollout-gate policy assertion                                                        |
| `specs/*` (create-project, seeded-apps, signup, test-support ×3)    |      9 |      26 | Remove rollout-timeout arg plumbing + `testInfo.setTimeout` extensions                          |
| **Total**                                                           | **43** | **320** | **net −277 LOC**                                                                                |

Validation on the applied patch: `apps/os` focused files **45/45 pass**, root
preview workflow/policy **148/148 pass**, `pnpm --dir apps/os typecheck` passes,
`git diff --check` passes. The remaining check is the live preview marathon (the
zero-retry proof), which only Depot CI can run — so this is documented as a
ready-to-apply patch rather than committed into this analysis PR.

## Round 3 — can we cut further? (mostly: we're near the floor)

Asked to cut again — less code, less mental clutter, more robustness, favouring
"make the product path work and tell the caller to retry" over harness
compensation — a wide re-investigation (three subagents + codex, Cloudflare +
capnweb source) found **one genuinely on-target low-faff win, a couple of
freebies, and an honest "don't over-refactor the rest."**

### ✅ The one high-value, low-faff addition: a clear "retry later" signal to the caller

This is exactly the "clearly communicate to the caller when it's no use" ask, and
it costs **~6-8 lines in one function, zero caller or codegen churn.** Today
`create()`'s default lane rejects at ~15 s (`PROJECT_CREATE_READY_TIMEOUT_MS`,
measured from create-entry) while the 75 s birth drive keeps committing — so a
caller can get an _undifferentiated_ error for a project that then becomes ready
(audit finding B3). The fix is **not** a typed-union return or a create/await
split (both were measured to _add_ net complexity — a union propagated through
`itx-api.generated.ts` + every caller, or a default-behaviour flip felt by every
out-of-tree script). It's simply: when the ready-wait deadline elapses _while
birth is still progressing_, throw a clearly-named **retryable** error —
`"project not ready yet — birth still in progress, retry"` — instead of a bare
`waitForEvent` timeout string, and measure that 15 s from when the ready-wait
opens, not from create-entry. No return-type change, no caller changes. The
caller's existing `try/catch` keeps working; the message now tells it to retry.
Combined with the round-2 self-heal, the harness relies on this clean signal +
the one CI retry — no gate.

### ✅ Freebies (safe, net-negative)

- **Merge the duplicate `#read` retry** — `WorkspaceGitRpcTarget.#read`
  (`rpc-targets.ts:2089-2095`) is byte-identical to `WorkspaceRpcTarget.#read`
  (`2028-2034`). Share one. **−7 LOC, ~0 risk.**
- **Delete `waitForOnboardingGreeting`** (`lib/onboarding-agent.ts:76-106`, ~25
  LOC) once the round-2 `waitForEvent` reset gap is closed — it is a _hand-rolled
  copy_ of exactly the re-arm-from-durable-cursor logic that fix gives
  `waitForEvent`. Sequence it after the gap fix; flip its test. **−25 LOC.**
- **Correct a stale comment.** `stream-unavailable.ts:6-13` claims capnweb "strips
  everything but `message`/`name`." That is **false** for the
  `@iterate-com/capnweb@0.10.0` fork this repo runs — it preserves own-enumerable
  Error properties and the `cause` chain (verified by round-trip). Misleading;
  fix regardless.

### 🟡 The real deeper clutter — but it is NOT low-faff, so don't bundle it

The retry _machinery_ is already near-minimal: only **~4 retry shapes** (one
shared `retryLoggedIdempotentOperation` reused at 6 read/append/barrier sites; the
`waitUntilProcessed` slice+backoff loop; the `#callProcessorOutcome`
acquire-dispose-race; the browser transport backoff) plus a few non-retry
recovery shapes. **A "grand unified retry" would be wrong** — the shapes are
distinct for real reasons (stub disposal, durable cursors, a reconnecting socket).
Consolidation is already done.

The genuine conceptual clutter is that a "retryable DO failure" has **three
representations**: (1) raw workerd flags in-worker; (2) the `stream-unavailable:`
message-string tag for the capnweb→browser hop; (3) an explicit
`{durableObjectReset, overloaded, retryable}` payload manually re-serialized
across the **native Worker→Worker wake hop** (`stream-subscribers.ts:1586-1596`).
Tempting to unify on a clean `retryable` own-property (the capnweb fork now
preserves it) — **but the string tag is load-bearing precisely where own-props
are not:** Cloudflare native Workers RPC preserves `message` but _strips own
properties_
([RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/)),
which is exactly why the wake hop hand-serializes the flags. Replacing the tag
with an own-property would **regress** any native-RPC hop unless each is taught to
re-serialize — a careful, medium-faff refactor across ~7 sites with a
serialization-dependency test. **Don't ride it in the lean fix.** File it as a
separate "unify the DO-failure signal" cleanup: worth doing for mental hygiene,
but not "little faff" and it doesn't change robustness — so it must not gate the
−277 deletion.

### Net for round 3

The lean fix stays the round-2 core (delete gate −277, close the `waitForEvent`
gap +12/−7). Round 3 _adds_ the clear caller error (~+6) and _removes_ ~32 more
via the two freebies — **~−300 LOC** total, with a clean "retry later" signal and
no new abstraction. Honest headline: **we're near the floor.** The remaining
clutter (three failure representations) is real but its cleanup is a separate
careful task, not a quick cut — bundling it would trade the "little faff" the ask
wants for churn that doesn't move robustness.

## Round 4 — two higher-altitude escape hatches tested; the floor holds

Round 4 deliberately did **not** re-map the retry sites (done twice). It tested
the two "make the problem disappear" ideas that would beat the lean fix — and both
bottom out, with Cloudflare's own docs as the deciding evidence. Reporting this
plainly rather than manufacturing a marginal cut.

- **Can the reset be avoided _by construction_ (so we don't need the +12 fix)?
  No.** The reset fires on _version reassignment of a placement_, and Cloudflare
  states it directly: _"The Durable Object will only be reset when it is assigned
  a different version"_
  ([gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)).
  A plain `wrangler deploy` reassigns the whole fleet, and — decisively — a
  brand-new per-test DO can be _created on a placement still serving old code_ and
  reset lazily when that placement flips; "fresh slug ⇒ cold start, never a reset"
  is **false**. The request version-pin
  (`cloudflare-worker-version-overrides.ts`) is an **asset/HTML** routing fix and
  does not touch DOs ("only one version of each Durable Object runs at a time").
  Deploying each run to a **fresh worker name** (no prior version ⇒ no reset) is
  _far more_ faff — unbounded worker/namespace/container accumulation, one-way
  container-class enablement, and it breaks the slot/lease model
  (`scripts/lib/do-reset.ts`). **You cannot deploy your way out; a bounded
  reset-classified retry is the irreducible answer.**

- **Is async-by-construction `create()` net-simpler? No — it's a wash that
  relocates complexity.** Making the default non-blocking deletes ~11 lines from
  `create()` but adds ~4 across the **2** bundled callers, and it (a) moves the
  from-entry single-deadline fail-fast guarantee _into_ callers (or re-introduces
  the same arithmetic there), (b) weakens the e2e helper's fail-fast, and (c)
  turns a safe-by-default into a footgun for out-of-tree "create-then-use"
  scripts. The fast path _already exists_ and **3 of 5 callers already use it**, so
  flipping the default buys no product-path robustness. The 7 saga steps are each
  load-bearing (the one "duplicate" — `driveBirth` in both lanes — is intentional).
  **Confirmed round-3: leave the shape; the clear escape-error message is the
  right, minimal fix for the ambiguity.**

**One genuinely new low-faff win surfaced:** the API-key **secret-seed failure is
swallowed to a bare `console.warn`** (`rpc-targets.ts:5301-5307`) that, on the
fast path, runs inside `ctx.waitUntil` with **no observer at all** — a real
silent-failure hole (violates "no silent failure"). Turn it into a telemetry
event (keep the non-throwing control flow — it self-heals on reveal). **~+2 LOC,
pure observability upside**, folded into the lean fix.

### Verdict: this is the floor

Four rounds converge. The lean fix — **delete the gate (−305), reuse the one-retry
helper on the one uncovered wait (+12/−7), a clear "retry later" error (+6), two
freebies (−32), the seed-telemetry line (+2)** ≈ **−300 LOC net, validated** — is
the floor for "less code + less clutter + more robustness + little faff." Further
cuts either (a) can't beat Cloudflare's eventual-consistency model, (b) relocate
complexity rather than remove it, or (c) are the separate medium-faff
[DO-failure-signal unification](../tasks/unify-durable-object-failure-signal.md)
that doesn't move robustness. Recommendation: **ship the lean fix; stop cutting.**

---

The detailed candidate analysis and the fuller (optional) version follow.

## The failure mode, stated correctly

After a fresh Worker version deploys, Cloudflare resets each Durable Object to
load the new code on first access — surfacing as `Durable Object reset because
its code was updated`. **Crucially, this rollout is _globally eventually
consistent per object/placement_** ([CF known
issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)):
old and new code coexist for a window, and _which_ identity resets _when_
depends on placement. This one fact is decisive — see C4.

Two things must be classified apart (they are conflated today at
`stream-unavailable.ts:38-45`, and the audit's finding **B2** shows why that
matters):

- **reset / retryable** — an idempotent caller may safely reacquire a fresh
  incarnation and retry.
- **overloaded** — Cloudflare says [do **not**
  retry](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/);
  retrying worsens the overload. Under the campaign's 48-Vitest-file + 16-worker
  fan-out, a deadline-long retry loop on `overloaded` becomes a synchronized
  request storm that hides the capacity signal.

## The four candidates

### C1 — Blanket retry at the itx client transport

Wrap the client so any RPC that returns a reset error retries transparently.
**Rejected.** capnweb is a pipelined, stateful session: a "call" is a property
chain whose intermediate stubs are server-held; a mid-chain reset invalidates
them, so blind replay is unsafe. And non-idempotent mutations can't be
auto-retried without keys the transport can't see. The _sound_ form collapses to
an opt-in per-method helper — which already exists server-side
(`retryIdempotentDurableObjectOperation`) — and still can't reach the
browser-button-driven creates the sign-up specs use. Narrower than C2, no unique
benefit.

### C2 — Self-healing create saga (server-side) ✅ core of the recommendation

Make each first-touch operation absorb a reset by reacquiring a fresh incarnation
under one deadline, so `create()` never surfaces the rollover. **Key finding
from prototyping: this is ~90 % already shipped.** The saga's reset-prone steps
already self-heal:

| Saga step                | First-touch DO         | Coverage today                                                                                                                  |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| root birth append        | STREAM                 | ✅ keyed-append door → `retryIdempotentDurableObjectOperation` (one bounded retry, dedupes on idempotency key)                  |
| subscriptions            | STREAM                 | ✅ rides the birth append                                                                                                       |
| processor birth drive    | PROJECT + notification | ✅ `ProcessorRelayRpcTarget.waitUntilProcessed` (#2266's reacquire-under-deadline)                                              |
| secret seed              | SECRET                 | ✅ swallow-and-reheal (ensure-create on reveal)                                                                                 |
| **`project/ready` wait** | STREAM                 | ❌ **the one gap** — `waitForEvent` (`rpc-targets.ts:628-719`) re-throws a reset instead of re-arming like `waitUntilProcessed` |

And every **on-demand** DO (agent, sandbox, scheduler, workspace, repo, secret)
returns a `ProcessorRelayRpcTarget`, so mid-test first-touches already self-heal
too — which **disproves C3's feared "mid-test reset" gap**. So C2 is not a build,
it's a _finish_: one production change (teach `waitForEvent` to re-arm on
reset/retryable under its existing deadline, with a small backoff), then the gate
is fully redundant. Provable (observes `project/ready` actually committed on the
fresh incarnation, bounded so a real wedge still fails), and it helps **real
users** creating a project against a just-deployed worker — not just tests.

### C3 — One canonical retrying fixture (test layer) ✅ complementary

A single `createTestProject()` (and Playwright sibling) that owns slug + create +
readiness + disposal and is the only way a test provisions — migrating the ~4
bypassing call sites (`agent-response-cache`, `project-ingress`,
`create-test-project-pool`, and the Playwright forged-session path). **Good
hygiene, low risk, test-only.** On its own it's insufficient (it can't reach the
`email-otp-signup` server-side browser-click create, and a fixture-layer retry
doesn't help production), and its retry is largely _redundant with C2_ once the
saga self-heals. But consolidating to one provisioner — with **no** rollout wait
and **no** per-spec `setTimeout` extension — is worth doing alongside C2.

### C4 — Cheap active readiness probe (keep a provable gate) ❌ not provably correct

Touch one identity per DO namespace class after deploy, confirm it serves the new
version, release all lanes. Attractive (≈6 RPCs vs #2140's ~500), **but the
premise is false.** Because rollout is globally eventually consistent
_per-object/placement_, a probe of identity A does **not** prove a future test
identity B (different placement) has converged. #2140 used _many_ identities
precisely because one is insufficient — reducing the sample doesn't turn a
statistical gate into a proof. This is the correction that decides the whole
question: **no gate/probe can prove convergence; only operations that survive a
reset whenever/wherever it lands are sound.** C4 is viable _only_ as an explicit,
owner-and-removal-criterion quarantine if C2 is judged too risky to land at once
— never as readiness proof.

## The fuller version (optional — only if you want more than the minimal fix)

> **Read the [TL;DR minimal fix](#tldr--the-minimal-fix-measured-net-277-loc-less-complexity-more-robust)
> first.** The two-change minimal fix above is the recommendation. The steps
> below are the same ideas expanded, plus the _optional_ extras (explicit create
> contract, fixture consolidation, canary, concurrency sweep). Treat them as a
> menu of independent follow-ups, **not** as a single package that must land
> together — bundling them was the over-build the maintainer pushed back on.

In order:

1. **Split the availability classifier** (foundational; fixes B2). Replace the
   single boolean with a discriminated result `"reset" | "retryable" |
"overloaded" | null` in `stream-unavailable.ts`. Reacquire only
   `reset`/`retryable` for idempotent callers; propagate `overloaded` as a typed
   backpressure outcome that is **never** looped on. Everything below depends on
   classifying correctly.

2. **Finish the saga self-heal** (C2). Teach `waitForEvent`
   (`rpc-targets.ts:628-719`) to re-arm on `reset`/`retryable` under its existing
   deadline (mirroring `waitUntilProcessed`), with a small inter-slice backoff so
   a genuinely resetting DO can't hot-loop the isolate. Durable rows replay from
   the pinned `replayAfterOffset`, so `project/ready` is genuinely observed, not
   skipped. Add a unit test that injects a reset (fake stub rejects once, then
   succeeds) and asserts create reaches ready; two consecutive resets past the
   deadline still reject.

3. **Model `create()`'s outcome explicitly** (fixes B3; this is the heart of
   "project creation"). Today default `create()` rejects at ~15 s while a 75 s
   birth drive keeps committing — a caller can get an _error_ for a project that
   durably succeeds and later becomes ready. Split the acknowledgement: `create()`
   returns after identity + birth-batch commit with the stable handle;
   `waitUntilReady({ timeoutMs })` is a separate explicit observation; a
   convenience returns `{ project, readiness: "ready" | "provisioning" }`. A
   committed create is **never** an undifferentiated error — which removes the
   "caller/test retry redials" crutch entirely.

4. **Consolidate fixtures** (C3). One canonical `createTestProject()` + Playwright
   sibling built on the explicit-outcome create; migrate the bypassing call
   sites; delete the per-spec `testInfo.setTimeout` extensions
   (`forged-session.ts:67`, `email-otp-signup.ts:62`).

5. **Delete the blind gate and all its plumbing** —
   `previewMinimumDeploymentAgeMs`, `resolvePreviewRolloutReadyAtMs`,
   `resolvePreviewRolloutRemainingSeconds`, the before-suite sleep, the
   rollout-settle lane, `packages/shared/src/test-support/preview-rollout-gate.ts`,
   the `PREVIEW_APP_ROLLOUT_*` env vars, and the `previewTestRolloutGate` config
   field. Findings **#1 and #2 both vanish** — there is no constant left to sit
   off the ladder.

6. **Replace the gate with a post-deploy recovery canary** (not a gate). Right
   after deploy, create a fresh real project (new identity, new placement) and
   assert it reaches ready **without a framework retry**. This is _positive proof
   the self-heal works_ on this exact deploy — release evidence — where the 90 s
   sleep only ever _hoped_. It runs once per deploy and fails the deploy loudly if
   recovery is broken; it does not gate the suite on a guessed duration.

7. **Then re-earn the concurrency & release evidence** (findings B4/B5). With
   `overloaded` no longer retried into a storm, re-sweep Vitest file workers
   (8/12/16/24/32/48) over ≥3 unchanged runs per the documented rule, pick the
   throughput knee, and run the 25-consecutive-zero-retry marathon on the final
   head. Only then is the campaign _proven_, not merely green.

### Correctness constraints (surfaced by the Codex design cross-check)

The Codex refactor pass independently landed on the same C2-primary / C3-complement
/ C1-defense-in-depth / C4-rejected ordering, and sharpened three things that make
the difference between a self-heal that's _safe_ and one that's subtly wrong:

- **⚠️ The retry must not span the identity-mint boundary.** The admin/test
  `create()` path _mints a fresh project ID_ via `AUTH.mintProjectId()` when none
  is supplied (`rpc-targets.ts:5380-5387`), so replaying an _unclassified_ failure
  **before** `primeProjectDirectory()` commits can create **conflicting
  identities** — there is already an expected-failure regression for exactly this
  (`apps/os/e2e/vitest/project-create-concurrency.regression.e2e.test.ts`). The
  rollout self-heal is still safe because the first project-DO touch happens
  _after_ directory priming (`:5209-5265`), so phase-2 retries retain one ID — but
  the invariant to state is the **narrow** one ("retry only after stable identity
  is established"), not "create is idempotent." A _complete_ fix routes admin
  slug→ID reservation through one authority (atomic reservation), at which point
  the regression test can flip to a normal idempotency assertion.
- **Fix the secret-seed catch-all while here.** The API-key seed today catches
  **every** error and only warns (`rpc-targets.ts:5280-5307`) — which conflicts
  with the "no silent failure" principle. Either model it as an explicit
  observable obligation (retry only the availability class; record a durable
  explanation on exhaustion) or fold secret existence into `project/ready`. Don't
  let the ambiguous swallow ride along under the new contract.
- **Size the deadline from measured p99, never a sleep.** The current create
  deadline is 15 s (`rpc-targets.ts:420-424`) and the flake hunt saw cold outliers
  near that boundary. If real resets routinely exhaust 15 s, pick a product SLO
  from the measured p99 — do not reintroduce a pre-test sleep to pad it.

### Why this is the right shape

- **It deletes more than it adds.** Gate + plumbing + per-spec `setTimeout` + the
  ambiguous-create crutch all go; the net new code is one `waitForEvent` branch,
  a discriminated classifier, an explicit create contract, one fixture, and a
  canary.
- **It's provably correct where a gate cannot be.** The reset is survived at the
  operation, so it holds whenever/wherever eventual consistency lands the
  rollover — not predicated on a guessed window.
- **It fixes the product, not the timeout**, and helps real users hitting a
  freshly deployed worker — the policy's first principle.
- **It separates two contracts that must not be conflated** (reset-recovery vs
  overload-backpressure), removing a latent storm under high fan-out.

### What would make this recommendation wrong

- If the `waitForEvent` re-arm can't be made bounded/idempotent cleanly (it can —
  `waitUntilProcessed` already is the template), OR
- If project birth has a real _service_ capacity limit (not just isolated IDs),
  in which case bounded admission (a semaphore/queue with durable terminal state)
  is the product fix and unbounded fixture concurrency is the actual bug — the
  concurrency sweep in step 7 is what tells us. Either way the blind sleep is not
  the answer.
- **Scope caveat:** `project/ready` proves the _birth saga_, not every future
  first-touch of an unrelated fresh Agent / Repo / Workspace object. On-demand DOs
  route through the relay's availability retry (so a reset is absorbed), but if any
  post-create first-touch operation is _non-idempotent_, it needs the same
  bounded, error-scoped treatment before the **whole-suite** gate is deleted — the
  create-leg self-heal alone doesn't certify it. Both audits agree a synthetic
  namespace sample cannot supply that proof either.

_Codex independent design cross-check: **folded in.** The dedicated Codex
`gpt-5.6-sol` design pass independently reached the same ordering — C2 self-healing
saga primary, C3 canonical fixture, C1 client-retry as defense-in-depth only (never
a global mutation-retry policy), C4 rejected — and converged on "make operations
idempotent + incarnation-independent, prove success from the actual project's
durable `project/ready`, add a post-deploy canary, do **not** restore a sampler."
It also supplied the classifier-split (B2) and the eventual-consistency correction
that upgraded this recommendation over the audit's original active-probe sketch, and
surfaced the identity-mint / secret-seed / deadline-sizing constraints above._
