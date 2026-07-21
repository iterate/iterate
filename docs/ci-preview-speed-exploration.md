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
the whole fleet.

### Baseline measurements

PostHog `preview e2e phase finished` events for the seven days ending
2026-07-21 show:

| Phase | Samples | p50 | p90 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| OS deploy | 25 | 143.6s | 183.7s | 210.0s |
| Whole deploy barrier | 27 | 147.1s | 189.3s | 311.5s |
| OS test | 35 | 165.9s | 229.3s | 290.9s |
| Streams deploy | 18 | 13.2s | 15.8s | 22.7s |
| Auth deploy | 25 | 16.2s | 20.4s | 22.3s |
| Semaphore deploy | 18 | 13.4s | 15.0s | 21.2s |
| Dummy Petshop deploy | 25 | 5.9s | 7.2s | 8.6s |

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

### Observability gap

The current state records only one aggregate deploy duration per app. Logs
show that this includes three unlike operations: reading Doppler-backed app
configuration, running the app's build/deploy command, and waiting for exact
version readiness. Recent `run` telemetry wraps the test phase after deploy,
so new preview runs do not emit the historical deploy phase events. Before
comparing deployment experiments, add first-class timings for configuration,
build/upload, and readiness and preserve aggregate deploy telemetry.

## Hypotheses and experiments

These are ordered by expected learning per unit of implementation risk, not by
how novel they are.

| Rank | Hypothesis | Experiment | Expected effect | Principal risk |
| ---: | --- | --- | --- | --- |
| 1 | Most pull requests upload byte-identical apps or workers. | Generalize the existing fixture fingerprint to every app and independently prove the recorded worker version is still serving before skipping. Fingerprint the deploy inputs, generated config, migrations, and secrets/config revision—not only source paths. | Removes 6–20s deploys and, for test-only OS changes, potentially the entire 1–3 minute OS rollout. | An incomplete fingerprint could falsely reuse stale code or config. |
| 2 | We cannot optimize what the aggregate app duration hides. | Emit and persist config-resolution, build/upload, readiness, slot-wait, and test-lane timings. Run the unchanged baseline repeatedly before changing behavior. | Fast feedback and attributable variance; no direct wall-time win. | Telemetry delivery must fail visibly if a green run would otherwise be incomplete. |
| 3 | Independent suites need not all wait for the slowest app. | Replace the single fleet barrier with a dependency DAG. Start an app's suite as soon as that app and its explicit dependencies are ready; retain a final fleet-coherence assertion. | Overlaps most Auth, Semaphore, fixture, and Streams tests with OS convergence. | An incomplete dependency graph can test incoherent versions. |
| 4 | Pure sidecars need not be rebuilt and redeployed with the stateful OS host. | Give sidecars independent fingerprints and deployment records; deploy only a changed sidecar, or reuse its proven version. | Removes redundant Vite/build/upload work and reduces Cloudflare calls. | Bindings and compatibility dates must participate in the fingerprint. |
| 5 | Most OS changes do not change Durable Object code. | Split stateless HTTP/asset ingress from the stateful Durable Object host. Deploy ordinary UI/API changes only to ingress, leaving the exact, proven DO host version in place; deploy both when DO inputs change. | Avoids DO convergence for the majority of changes while preserving per-preview state. | A large architectural boundary; RPC/API compatibility must be explicit and tested. |
| 6 | Warm idle stateful deployments can absorb convergence before a PR needs them. | Maintain two stateful worker generations per slot. Deploy and prove the inactive generation, then switch a stable per-slot ingress binding after it is ready. | Moves rollout variance out of the final cutover and makes switching cheap. | Doubles stateful resources, complicates migrations and garbage collection, and may still require a control-plane binding deploy. |
| 7 | New namespaces avoid proving replacement of already-live DO isolates. | Deploy a head-addressed stateful worker/namespace behind a stable per-slot ingress router, then garbage-collect superseded generations after bounded retention. | Turns convergence from replacement of a fleet into first use of isolated state. | Worker/resource quotas, migration history, cleanup reliability, and route indirection. |
| 8 | Build work can be reused independently of deployment. | Build each app once into a content-addressed artifact, cache it by exact inputs, and make the deploy stage upload that artifact without rerunning compilation. | Cuts local work and makes Cloudflare time separately measurable; especially useful across reruns. | Wrangler-generated metadata and secret/config binding differences may make artifacts unsafe to reuse blindly. |
| 9 | Control-plane contention is account-wide. | Run identical deploy probes across isolated preview accounts/tokens and compare upload, version creation, and readiness distributions. | Determines whether account sharding can reduce rate limiting and tail latency. | More accounts, secrets, zones, and resource provisioning; it does not remove intrinsic global rollout time. |
| 10 | Normal code changes should not rerun resource provisioning and migrations. | Split resource/schema reconciliation from code upload. Cache a verified resource-generation marker per slot and run the slow lane only when schema/config inputs change. | Removes repetitive API and remote D1 operations. | Drift must be detected, not silently trusted; migration ordering remains strict. |
| 11 | A smaller Cloudflare contract lane can preserve platform confidence while local execution covers application breadth. | Run most deterministic unit/integration suites against local production-shaped workers while a bounded cross-app contract suite runs on the deployed preview. | Large test-stage reduction. | This changes what preview e2e proves and cannot replace deployment/DO integration coverage without explicit evidence. |

### Known non-starter: direct version upload for current OS

The attractive `wrangler versions upload` route cannot be applied directly to
the current generated OS configuration. OS deploys exported entrypoints, and
Cloudflare rejects version upload for configurations containing `exports`.
This remains worth retesting after a stateless/stateful split, when the
front-door worker may no longer need those exports.

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

| UTC | Result | Benefit inherited |
| --- | --- | --- |
| 2026-07-21 21:44 | Fast-forwarded `e8e4a33c8` to `767baafc3`. | PR #2227 made all OS Vitest files eligible to run in parallel; PR #2226 added unified CI/test telemetry. |
| 2026-07-21 21:47 | Already current at `767baafc3`. | No additional changes. |

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

| Date | Experiment | Result | Decision |
| --- | --- | --- | --- |
| 2026-07-21 | Merge latest `main` during exploration. | Inherited a 57% OS Vitest improvement and unified telemetry before duplicating that work. | Continue the 10-minute merge cadence. |
| 2026-07-21 | Query seven days of preview phase telemetry. | OS deploy p50/p90 is 143.6s/183.7s; non-OS deploys are at most 16.2s p50. OS tests are independently 165.9s p50. | Treat deployment and test execution as separate workstreams. |
