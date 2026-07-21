# Cloudflare preview speed exploration

This is the working record for experiments to reduce the time from a pull
request update to a green, fully independent Cloudflare preview environment.
It intentionally records rejected ideas and negative results as well as
winners so later work does not repeat the same control-plane experiments.

## Goal and constraints

The target is a preview result in roughly one minute without weakening what a
green preview means.

- Every active preview remains isolated from every other preview. It must not
  share mutable application state, Durable Objects, D1 databases, KV
  namespaces, queues, or a worker deployment that another pull request can
  replace underneath it.
- Expected outcomes must be modelled explicitly. Control-plane errors,
  incomplete rollout, stale code, and missing telemetry may not be treated as
  harmless noise.
- Tests must exercise the exact code and configuration recorded for the pull
  request.
- The Cloudflare control plane is treated as a scarce, high-variance external
  dependency. Experiments should remove calls from the critical path or make
  them independently observable rather than retrying them more aggressively.

## Current critical path

The preview workflow currently runs as one 16-core Depot job:

1. Check out the pull request, install Node, pnpm, dependencies, and Doppler.
2. Claim or renew one of 19 preview slots.
3. Deploy every affected app concurrently (up to five at a time).
4. Wait for the entire selected fleet to pass readiness.
5. Run all selected app suites concurrently.

OS and Streams readiness is materially different from a normal HTTP smoke.
Each deployment waits for exact Worker-version evidence from many Durable
Object placements. OS checks 10 waves of eight indexed `CapabilityHost`
placements plus the project-shaped namespaces and build coordinator, followed
by a stability revalidation. Streams uses the same 10-by-eight placement
shape. This makes the slowest DO convergence probe the deployment barrier for
the whole fleet. OS currently exercises 25 Durable Objects per wave, so its
initial pass and complete-set revalidation make 500 DO RPCs in the green path.
Cloudflare documents this rollout as eventually consistent: existing objects
may run old code for seconds or minutes after a deploy ([Durable Object known
issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)).

### Baseline measurements

PostHog `preview e2e phase finished` events for the seven days ending
2026-07-21 show:

| Phase                | Samples |    p50 |    p90 | Maximum |
| -------------------- | ------: | -----: | -----: | ------: |
| OS deploy            |      25 | 143.6s | 183.7s |  210.0s |
| Whole deploy barrier |      27 | 147.1s | 189.3s |  311.5s |
| OS test              |      35 | 165.9s | 229.3s |  290.9s |
| Streams deploy       |      18 |  13.2s |  15.8s |   22.7s |
| Auth deploy          |      25 |  16.2s |  20.4s |   22.3s |
| Semaphore deploy     |      18 |  13.4s |  15.0s |   21.2s |
| Dummy Petshop deploy |      25 |   5.9s |   7.2s |    8.6s |

The latest inherited OS-test parallelism change provides a newer point
measurement. Its final preview run took 4m59s: OS deploy 115.5s, Streams deploy
88.2s, OS test 158.9s, Streams test 57.4s, and OS Vitest 78.28s. The prior
seven-worker OS Vitest run took 181.77s, so that change cut the Vitest portion
by 57% while leaving the Cloudflare convergence tail and remaining OS lanes as
the critical path.

An earlier production-shaped run for PR #2169 took 5m33s. Its Depot machine
averaged 8.68% CPU and 6.88% memory, with uploads/version creation completing
well before OS and Streams exact-version readiness. That is evidence against
machine saturation as the primary deployment bottleneck.

### Baseline instrumentation

The preview state records one aggregate deploy duration per app. Logs show
that this includes three unlike operations: reading Doppler-backed app
configuration, running the app's build/deploy command, and waiting for exact
version readiness. This exploration adds first-class PostHog run, lane, and
phase events for configuration, command, readiness, and reuse proof while
preserving the aggregate duration.

The first instrumented all-app run on the already-leased `preview-6`, Depot
job [`262mkptj04`](https://depot.dev/orgs/0p91s0lz49/workflows/dp39260qtj?job=262mkptj04),
passed in 4m38s. PostHog received the following ledger for head `a311b1e`:

| App             | Config | Command | Readiness | Reuse proof |   Total |
| --------------- | -----: | ------: | --------: | ----------: | ------: |
| OS              |  0.31s |  46.43s |    55.48s |           - | 102.22s |
| Streams example |  0.33s |  13.10s |    94.16s |           - | 107.59s |
| Auth            |  0.00s |  15.88s |     0.31s |           - |  16.19s |
| Semaphore       |  0.00s |  12.50s |     0.19s |           - |  12.70s |
| Dummy Petshop   |  0.00s |       - |         - |       0.23s |   0.25s |

The deploy run itself was 111.61s. OS e2e was 149.7s (69s Vitest, 143s
Playwright), Streams 61.8s, Semaphore 22.8s, Auth 12.1s, and Dummy Petshop
5.7s. All apps and tests passed without a code-update reset. This is a warm
slot timing sample, not evidence that the fresh-slot correctness failure is
resolved.

Before the preview command, the standard runner spent 4.8s in dependency and
Doppler installation and 10.0s from job start to starting that command. That
is small beside Cloudflare readiness, but isolated enough for an inexpensive
baked-image A/B test.

The baked-image arm, Depot job
[`gh8d1slkwr`](https://depot.dev/orgs/0p91s0lz49/workflows/crhbq9gns8?job=gh8d1slkwr),
passed in 4m35s. It started the preview command 5.60s after job start instead
of 9.96s, a 4.36s/44% startup reduction. Its preinstalled browser also let the
OS Playwright lane start 0.68s after the app test began instead of 6.86s. The
whole job improved by only 2.34s because unrelated remote variance more than
absorbed some of those deterministic savings: the baked arm's deploy/test
runs were 104.83s/160.17s versus the control's 111.61s/roughly 151s. OS alone
spent 38.93s in its deploy command, 61.29s in readiness, and 158.50s testing.
This validates the baked runner as a small win while reinforcing that
Cloudflare convergence and OS test execution remain the first-order work.

The first content-addressed experiment applies deploy reuse to OS, but only
for changes that do not affect its deployed artifact. The reuse
contract requires the same slot and Worker name, a conservative Git hash over
OS runtime/build code plus workspace dependencies and generated-config inputs,
an opaque hash of the complete Doppler config, a prior fully green entry, and
a live health response from that entry's exact immutable Worker version. An
e2e, root-spec, or mobile-only change still runs all selected deployed tests,
but no longer needs to create another behavior-equivalent OS version and wait
for another global Durable Object rollout. Any missing or mismatched proof
falls through to the ordinary deploy. OS normally derives a head-pinned
pkg.pr.new SDK URL; reuse deliberately retains its prior immutable URL only
when the fingerprint also proves every SDK package and publishing input is
unchanged. The fingerprint also includes the exact Node runtime, platform, and
architecture because the Depot snapshot tag is mutable; rebuilding that image
with a newer Node patch must invalidate prior artifacts even when Git inputs
are identical.

The first recording run, Depot job
[`hsvlw7vbq9`](https://depot.dev/orgs/0p91s0lz49/workflows/t8bx7lfm3d?job=hsvlw7vbq9),
passed in 4m45s wall clock and 4m34s inside the preview command. Its deploy
barrier was 94s and its test barrier was 175s. OS took 61.64s to deploy and
30.61s to pass readiness, then its 174.61s test lane needed six retries. Two
were explicit post-readiness code-update resets; the others were a stream wait
timeout, two correlated internal errors, and a 120-second test timeout. A
targeted settled-deployment follow-up then ran the affected Project
stream-subscribe test 10 times without deploying or erasing: 10/10 passed,
zero retries, 11.96–19.14s (15.54s median). This does not prove every retry has
the same cause, but it supports the prediction that avoiding a behavior-
equivalent rollout removes both the convergence delay and its correctness
hazard.

The merged-main recording run, Depot job
[`w6f1rkx69x`](https://depot.dev/orgs/0p91s0lz49/workflows/17106btw54?job=w6f1rkx69x),
then passed in 4m28s. OS deployment and readiness took 93.67s, OS tests took
153.99s, and no test needed a retry. It recorded OS Worker version
`92e30c6d-c9de-4afd-868e-723a4f196f73` and is the same-slot, same-input
control for the following no-deploy arm.

The no-deploy arm, Depot job
[`zcrrj5v518`](https://depot.dev/orgs/0p91s0lz49/workflows/6g1nc7w1w5?job=zcrrj5v518),
changed only OS e2e documentation and passed in 3m12s. The orchestrator proved
and retained exact OS version `92e30c6d-c9de-4afd-868e-723a4f196f73` in
0.82s instead of spending 93.67s on its deploy/readiness path. OS tests remained
the same-sized work at 156.88s and again needed zero retries. End to end, the
same-slot treatment saved 76 seconds (4m28s to 3m12s), matching the 77-second
reduction in the fleet deploy barrier. This is causal evidence that proven
reuse removes deployment time rather than merely shifting it into tests.

The generalized all-app recording arm, Depot job
[`vfx607kt7h`](https://depot.dev/orgs/0p91s0lz49/workflows/6klnbcjs39?job=vfx607kt7h),
passed in 4m02s with zero retries. It intentionally uploaded all five apps to
establish the new deployment identities. OS was the deploy barrier at 83.19s
(41.96s command plus 40.72s readiness) and the test barrier at 139.91s.
Streams also made the rollout cost visible: its command took 12.47s, while
exact-version readiness took 39.19s after two old Durable Object placements
lagged. The remaining deploys were 6.60–16.43s. This is the control for an
orchestrator-test-only head that selects and tests the whole fleet without
changing any app's deployment fingerprint.

The first full-fleet reuse arm, Depot job
[`zl0r7x77kp`](https://depot.dev/orgs/0p91s0lz49/workflows/3hb1srxjhw?job=zl0r7x77kp),
passed with zero retries but took 5m00s after exposing one deliberately
fail-closed false negative. Dummy Petshop, Semaphore, and Auth retained their
exact versions in 0.33–1.10s. Streams encountered one stale sampled placement
four minutes after the recording run, then retained exact version
`875162cb-2a8a-4d64-a194-f68e0c276ff6` after the full ten-wave double check in
15.2s. OS likewise reached ten exact waves around 15s, but the shared 15-second
single-request deadline expired during its required complete-set revalidation.
It therefore rejected reuse and normally deployed version
`39727728-3af0-4baf-af66-d69cd7bafb90`, costing 122.6s. The static fingerprint,
slot, config, and recorded-version proofs had all matched; only the live proof
deadline failed. Reuse now has a separate bounded 60-second budget, while the
cheap single-serving probe remains 15 seconds and the exact-version double
sample remains mandatory.

### Fresh-slot correctness baseline

Depot run [`jfq7cp9kfk`](https://depot.dev/orgs/0p91s0lz49/workflows/p5bl4dpj76?job=qr4sf7mn3h&attempt=hld2q92zdj)
leased and erased `preview-6`, then deployed all five apps. OS took 83.4s,
including 19.4s of readiness; Streams took 56.6s, including 37.2s of
readiness. Both completed all ten exact-version waves and the ten-second
complete-set revalidation.

That gate did not make the subsequent test run coherent. During the gate and
for 32 seconds after OS was declared ready, Cloudflare telemetry recorded 20
explicit code-update-reset log events on the exact deployed version across 12
Durable Object identities. The broader reset-message query found 30 events
across 15 identities through 112 seconds after readiness. Two OS tests
retried. One recovered; the other first received
Cloudflare storage reference `b6iff3rqinq0dn5g3er86lli`, then failed its retry
because the first attempt had durably created a secret before the reset.

That final failure exposed a separate retry-isolation defect. The test's
module-scoped random suffix survived Vitest's retry, so the retry reused the
first attempt's project and secret while opening a different ephemeral egress
tunnel. The test now creates its suffix inside each test attempt, matching the
suite's stated fresh-project retry contract.

This falsifies the idea that the current synthetic sample is a sufficient
global rollout barrier. It proves only the sampled identities. Arbitrary real
objects can still restart on their first post-deploy invocation. Removing the
gate is rejected, but making it still broader cannot provide a finite proof
over arbitrary identities. The architecture experiments must therefore avoid
replacing live stateful namespaces on the common path, or the operation layer
must explicitly make restart recovery atomic and idempotent.

There is a second, sharper limit: the ten waves make 250 observations over 241
distinct identities and the complete-set revalidation repeats those same
identities, for 500 green RPCs, but `deploymentVersion()` only reads Worker
metadata. It performs no Durable Object storage operation. Cloudflare's
documented update behavior permits a superseded isolate to finish non-storage
work and then throw `Durable Object reset because its code was updated` on its
first storage access. The gate therefore proves that sampled DO code answered,
not that those objects crossed the storage/global-uniqueness handoff. A
storage-fenced probe (`ctx.storage.get` before returning the version) is a
useful diagnostic experiment, but remains a bounded sample rather than a
global proof.

## Hypotheses and experiments

These are ordered by expected learning per unit of implementation risk, not by
how novel they are.

| Rank | Hypothesis                                                                                                            | Experiment                                                                                                                                                                                                                                                     | Expected effect                                                                                    | Principal risk                                                                                                                   |
| ---: | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Most pull requests upload byte-identical apps or workers.                                                             | Generalize the existing fixture fingerprint to every app and independently prove the recorded worker version is still serving before skipping. Fingerprint the deploy inputs, generated config, migrations, and secrets/config revision—not only source paths. | Removes 6–20s deploys and, for test-only OS changes, potentially the entire 1–3 minute OS rollout. | An incomplete fingerprint could falsely reuse stale code or config.                                                              |
|    2 | We cannot optimize what the aggregate app duration hides.                                                             | Emit and persist config-resolution, build/upload, readiness, slot-wait, and test-lane timings. Run the unchanged baseline repeatedly before changing behavior.                                                                                                 | Fast feedback and attributable variance; no direct wall-time win.                                  | Telemetry delivery must fail visibly if a green run would otherwise be incomplete.                                               |
|    3 | Independent suites need not all wait for the slowest app.                                                             | Replace the single fleet barrier with a dependency DAG. Start an app's suite as soon as that app and its explicit dependencies are ready; retain a final fleet-coherence assertion.                                                                            | Overlaps most Auth, Semaphore, fixture, and Streams tests with OS convergence.                     | An incomplete dependency graph can test incoherent versions.                                                                     |
|    4 | Pure sidecars need not be rebuilt and redeployed with the stateful OS host.                                           | Give sidecars independent fingerprints and deployment records; deploy only a changed sidecar, or reuse its proven version.                                                                                                                                     | Removes redundant Vite/build/upload work and reduces Cloudflare calls.                             | Bindings and compatibility dates must participate in the fingerprint.                                                            |
|    5 | Most OS changes do not change Durable Object code.                                                                    | Split stateless HTTP/asset ingress from the stateful Durable Object host. Deploy ordinary UI/API changes only to ingress, leaving the exact, proven DO host version in place; deploy both when DO inputs change.                                               | Avoids DO convergence for the majority of changes while preserving per-preview state.              | A large architectural boundary; RPC/API compatibility must be explicit and tested.                                               |
|    6 | Warm idle stateful deployments can absorb convergence before a PR needs them.                                         | Maintain two stateful worker generations per slot. Deploy and prove the inactive generation, then switch a stable per-slot ingress binding after it is ready.                                                                                                  | Moves rollout variance out of the final cutover and makes switching cheap.                         | Doubles stateful resources, complicates migrations and garbage collection, and may still require a control-plane binding deploy. |
|    7 | New namespaces avoid proving replacement of already-live DO isolates.                                                 | Deploy a head-addressed stateful worker/namespace behind a stable per-slot ingress router, then garbage-collect superseded generations after bounded retention.                                                                                                | Turns convergence from replacement of a fleet into first use of isolated state.                    | Worker/resource quotas, migration history, cleanup reliability, and route indirection.                                           |
|    8 | Build work can be reused independently of deployment.                                                                 | Build each app once into a content-addressed artifact, cache it by exact inputs, and make the deploy stage upload that artifact without rerunning compilation.                                                                                                 | Cuts local work and makes Cloudflare time separately measurable; especially useful across reruns.  | Wrangler-generated metadata and secret/config binding differences may make artifacts unsafe to reuse blindly.                    |
|    9 | Control-plane contention is account-wide.                                                                             | Run identical deploy probes across isolated preview accounts/tokens and compare upload, version creation, and readiness distributions.                                                                                                                         | Determines whether account sharding can reduce rate limiting and tail latency.                     | More accounts, secrets, zones, and resource provisioning; it does not remove intrinsic global rollout time.                      |
|   10 | Normal code changes should not rerun resource provisioning and migrations.                                            | Split resource/schema reconciliation from code upload. Cache a verified resource-generation marker per slot and run the slow lane only when schema/config inputs change.                                                                                       | Removes repetitive API and remote D1 operations.                                                   | Drift must be detected, not silently trusted; migration ordering remains strict.                                                 |
|   11 | A smaller Cloudflare contract lane can preserve platform confidence while local execution covers application breadth. | Run most deterministic unit/integration suites against local production-shaped workers while a bounded cross-app contract suite runs on the deployed preview.                                                                                                  | Large test-stage reduction.                                                                        | This changes what preview e2e proves and cannot replace deployment/DO integration coverage without explicit evidence.            |

### Known non-starter: direct version upload for current OS

The attractive `wrangler versions upload` route cannot be applied directly to
the current generated OS configuration. OS deploys exported entrypoints, and
Cloudflare rejects version upload for configurations containing `exports`.
This remains worth retesting after a stateless/stateful split, when the
front-door worker may no longer need those exports ([Durable Object class
exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).

### Selected first architecture spike

Split the Streams Example App's `StreamDurableObject` into a dedicated,
per-slot backend Worker and keep its public edge Worker stateless. Record
separate deployment-input fingerprints and exact versions for both Workers.
For an edge-only change, reuse the proven backend and test after edge
readiness; for a backend change, retain the existing broad convergence gate.

Run 10 warm-slot revisions of each kind. Acceptance requires exact-version
telemetry for both Workers, no hidden lifecycle resets or retries, unchanged
cross-preview isolation, and cleanup/rollback proof. The measured hypothesis
is that an edge-only Streams deployment falls from 88.2s to roughly 14–25s by
removing its observed 60–75s DO convergence tail. If the narrow split works,
partition OS by state-domain change affinity instead of immediately creating
one giant state host.

A higher-ceiling follow-up is an immutable per-head Worker behind a stable
Workers for Platforms dispatcher. Fresh Worker identities imply fresh Durable
Object namespaces, while dynamic dispatch avoids per-head DNS/routes
([dynamic dispatch](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/),
[dispatch bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)).
This must first prove the real OS export, Assets, RPC/service-binding, and
container inventory; it is not a toy-Worker result.

## Measurement protocol

Each behavior-changing experiment needs at least:

- an unchanged baseline and experiment run on the same branch and slot when
  possible;
- separate config, build/upload, exact-version readiness, and suite timings;
- exact head SHA, worker version IDs, slot, account, attempt, and Cloudflare
  request/error identifiers in the evidence;
- p50 and tail comparisons rather than a single best run;
- post-run verification that the preview still serves the recorded versions
  and no unexplained error/retry volume was introduced;
- a declared rollback condition.

Experiments that save time by weakening isolation, version certainty, durable
state correctness, or telemetry completeness are rejected even if the wall
clock improves.

## Rolling-main log

This branch fetches and merges `origin/main` at least every 10 minutes while
the exploration is active.

| UTC              | Result                                     | Benefit inherited                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-21 21:44 | Fast-forwarded `e8e4a33c8` to `767baafc3`. | PR #2227 made all OS Vitest files eligible to run in parallel; PR #2226 added unified CI/test telemetry.                                                                                                                               |
| 2026-07-21 21:47 | Already current at `767baafc3`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 21:53 | Already current at `767baafc3`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 22:02 | Already current at `767baafc3`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 22:08 | Merged `23d0ae822` from `origin/main`.     | PR #2234 enlarged preview favicon markers; no pipeline speedup.                                                                                                                                                                        |
| 2026-07-21 22:12 | Already current at `23d0ae822`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 22:19 | Merged `2de2b7eeb` from `origin/main`.     | PR #2232 independently confirms rollout/readiness variance dominates the job tail and the eight Playwright queues are balanced; no direct pipeline speedup. PR #2230 is product-only.                                                  |
| 2026-07-21 22:26 | Merged `9ac198982` from `origin/main`.     | PR #2235 replaces a racy post-settlement snapshot assertion with an awaited event, reducing OS e2e flake risk without adding sleeps or runtime.                                                                                        |
| 2026-07-21 22:35 | Merged `ed36ba327` from `origin/main`.     | PR #2223 materially changes the deployed OS template/SDK and its e2e coverage, so it correctly forces a new OS deployment; no direct pipeline speedup is expected.                                                                     |
| 2026-07-21 22:42 | Already current at `ed36ba327`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 22:45 | Already current at `ed36ba327`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 22:52 | Merged `775f90d52` from `origin/main`.     | PR #2236 added exact-deployment focused test reuse. This immediately supplied the repeatable diagnostic loop; because the preview orchestrator is conservatively fingerprinted, the merge itself still requires one new OS deployment. |
| 2026-07-21 22:57 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:05 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:13 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:16 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:23 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:27 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:34 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |
| 2026-07-21 23:40 | Already current at `775f90d52`.            | No additional changes.                                                                                                                                                                                                                 |

## Decision log

- Preserve the 19-slot lease model as the control plane for now. It already
  prevents one pull request from overwriting another and erases state on
  handover. Optimize what happens within a lease before replacing it.
- Do not interpret a finite readiness sample as proof of global rollout. The
  current probes are useful evidence about named placements, but the product
  operation and test-version overrides must remain the authority for which
  version a test invokes.
- Prefer removing a deployment from the critical path over making an
  inherently variable global rollout poll more aggressively.

## Experiment log

| Date       | Experiment                                   | Result                                                                                                                                                                                                                    | Decision                                                                                                                                |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-21 | Merge latest `main` during exploration.      | Inherited a 57% OS Vitest improvement and unified telemetry before duplicating that work.                                                                                                                                 | Continue the 10-minute merge cadence.                                                                                                   |
| 2026-07-21 | Query seven days of preview phase telemetry. | OS deploy p50/p90 is 143.6s/183.7s; non-OS deploys are at most 16.2s p50. OS tests are independently 165.9s p50.                                                                                                          | Treat deployment and test execution as separate workstreams.                                                                            |
| 2026-07-21 | Restore and split deployment telemetry.      | Added deploy run/lane events plus config, command, readiness, and reuse-proof phase events.                                                                                                                               | Use the next preview run as the attributable baseline.                                                                                  |
| 2026-07-21 | Instrumented warm-slot all-app baseline.     | 4m38s green; deploy run 111.61s. OS was 46.43s command + 55.48s readiness; Streams was 13.10s command + 94.16s readiness.                                                                                                 | Cloudflare readiness, not local setup, dominates; preserve this head as the control for later comparisons.                              |
| 2026-07-21 | Fresh-slot all-app baseline on `preview-6`.  | The readiness gate passed, then real OS Durable Objects emitted 20 explicit code-update-reset logs (30 broader reset events) and one test failed after a non-atomic retry.                                                | Treat the current gate as a finite sample, not global convergence; prioritize immutable/state-host splits.                              |
| 2026-07-21 | Start preview CI from the baked workspace.   | Startup fell 9.96s → 5.60s and Playwright launch delay fell 6.86s → 0.68s; remote variance limited the end-to-end sample to 4m38s → 4m35s.                                                                                | Keep the baked runner, but do not mistake its deterministic setup win for a Cloudflare-tail fix.                                        |
| 2026-07-21 | Isolate retry identities per test attempt.   | A module-scoped suffix made Vitest retry against durable state left by the failed first attempt while Captun supplied a different egress URL.                                                                             | Generate the suffix inside each test attempt so transient recovery cannot deterministically poison its retry.                           |
| 2026-07-21 | Validate retry isolation on the warm slot.   | Depot job `q3kwz26lqm` passed the formerly poisoned integration file. OS deploy was 149.3s (38.6s command + 110.3s readiness); a different stream-subscribe timeout made OS tests 154.4s and the job 5m23s.               | Keep the isolation fix; separately diagnose the visible unrelated retry and remove byte-identical OS rollouts from test-only pushes.    |
| 2026-07-21 | Add fail-closed OS deployment reuse.         | Implemented source, full-Doppler-config, same-slot/name, prior-green, and live exact-version proofs. The first run records the new identity; a subsequent e2e-only revision is the A/B arm.                               | Measure before generalizing to other apps; any absent proof retains the full deploy.                                                    |
| 2026-07-21 | Record the deployment-reuse control.         | Depot job `hsvlw7vbq9` passed in 4m45s, but OS deployment/readiness took 92.69s and the OS lane took 174.61s with six retries, including two code-update resets after readiness.                                          | The readiness sample is not a convergence proof; use this exact slot and recorded version for the no-deploy arm.                        |
| 2026-07-21 | Repeat the failed stream test after rollout. | The exact-deployment target runner passed 10/10 attempts with zero retries in 11.96–19.14s (15.54s median), without deploy or erase.                                                                                      | Rollout contamination is the leading explanation; retain full-suite A/B and telemetry as the stronger acceptance test.                  |
| 2026-07-21 | Re-record after merging the latest main.     | Depot job `w6f1rkx69x` passed in 4m28s. OS deployment/readiness took 93.67s; OS tests took 153.99s with zero retries. It recorded version `92e30c6d-c9de-4afd-868e-723a4f196f73`.                                         | Use this run as the same-slot control for an e2e-documentation-only revision that must reuse this exact OS version.                     |
| 2026-07-21 | Reuse the proven OS deployment.              | Depot job `zcrrj5v518` passed in 3m12s. Exact-version and same-input proof took 0.82s versus the control's 93.67s deploy; OS tests took 156.88s with zero retries.                                                        | Generalize fail-closed reuse to every app, then run an all-app test-only head to measure the full-fleet ceiling.                        |
| 2026-07-21 | Record generalized all-app identities.       | Depot job `vfx607kt7h` passed in 4m02s with zero retries. OS was the 83.19s deploy barrier and 139.91s test barrier; Streams spent 39.19s of its 52.25s deploy waiting for exact-version rollout.                         | Use this exact slot and five-version set as the control for an orchestrator-test-only full-fleet reuse arm.                             |
| 2026-07-21 | Reuse the recorded full fleet.               | Depot job `zl0r7x77kp` passed in 5m00s with zero retries. Four apps reused; OS reached all ten exact waves near 15s but its 15s deadline expired during mandatory revalidation, so it failed closed into a 122.6s deploy. | Give the multi-wave reuse proof a separate 60s maximum; retain the 15s single-serving probe and fail-closed exact-version double check. |
