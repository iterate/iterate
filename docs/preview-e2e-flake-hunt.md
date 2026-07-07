# Preview e2e flake hunt

> This document is the evidence log — every flake, root cause, and marathon
> run. The **policy** distilled from it (one retry layer, watchdog sizing,
> retry telemetry) lives in [testing.md → Retries and
> timeouts](testing.md#retries-and-timeouts).

Goal: run the full preview e2e lane against a real preview environment 50
times in a row without a single flake, fixing and documenting every failure
encountered along the way.

Round 1 (PR #1644) found and fixed nine root causes and merged them to main.
Round 2 (PR #1653, merged) added flakes 16–17 and the `preview.ts` lease/retry
hardening, and merged main's worker-build pipeline (#1612) — whose `#writeChain`
write serialization supersedes round 2's standalone flake-15 fix. Round 3
(this PR) carries on toward 50 consecutive green runs, targeting the two
pre-existing flakes still open after the round-2 merge (see "Round 3 targets").

Method: deploy this PR's preview slot, then loop `pnpm preview test
--pull-request-number <N>`, failing fast on the first failure. Every failure
gets a root-cause diagnosis and the smallest reliable fix, recorded below; a
failure resets the consecutive-green counter. `scripts/preview/flake-hunt-loop.sh`
drives the loop (preflight full-fleet deploy → optional warmup → counted runs).

The trustworthy count runs **in Depot CI, not on a workstation** (a laptop
sleeping mid-loop produced hours of phantom "degradation" — see the lab note):
`.depot/workflows/preview-e2e-marathon.yml` runs that same loop on Depot infra,
launched with `depot ci run --workflow .depot/workflows/preview-e2e-marathon.yml`.
Local runs are for fast iteration while fixing a flake; the 50-consecutive-green
bar is measured on Depot.

## Run log

Depot marathons (the counted lane), 2026-07-05:

- **marathon1**: 17 clean, run 18 failed — sandbox cold boot ~132s vs 120s
  budget (fixed: 180s, flake 20).
- **marathon2** `0rm2n02tk2`: 4 clean, run 5 failed — flake 21 (blank
  route-pending panel).
- **marathon3** `nqchbzzr63`: 11 clean, run 12 wedged at the container
  instance cap — flake 23 (stopped containers never release their slots).
- **marathon4** `xw5qzkt05d`: 16 clean at ~65-90s/run (no cap slowdown — the
  flake-23 fix held; slot recycled at active:3-5 throughout), run 17 failed —
  `stream-lifecycle` hit a Cloudflare DO-storage fault TWICE (attempt 1 timed
  out, the retry got `Internal error in Durable Object storage caused object
to be reset; reference = v6frpcasd5hp70rrhv37kmr4`) during an active
  Cloudflare "network performance in North America" incident (preview DOs are
  ENAM). Fresh project per attempt, so two independent draws both faulted —
  platform weather, nothing app-side to fix; bumped CI retries 1→2
  (vitest + Playwright) so a burst needs three consecutive faults to fail a
  run.
- **marathon5** `wdq4c1mv2q`: **32 clean** (new record), run 33 wedged at the
  600s watchdog — sandbox starts degraded as the instance pool saturated at
  `assigned == 100` even with destroy-on-idle (see the marathon5 addendum
  under flake 23). Preview cap raised 100 → 500 for the marathon, then reset
  to 31 after Cloudflare rejected 500 against the preview account memory quota.
- **marathon6** `gb1g4sg7rs`: 25 clean at a steady ~60-90s/run — cap 500
  eliminated the saturation slowdown entirely (pool rode at `assigned: 491`
  with NO latency growth, where cap-100 marathons were at 3-5min/run by run
  20). Run 26 failed on the lane's one retry-less gate: `onboarding-smoke.ts`
  — the onboarding agent didn't greet within 90s ("saw 0 events") and the
  remote timeout crashed the bare tsx process. Fix: the smoke now makes 3
  attempts, each with a fresh session + project, matching the vitest lane's
  `retry: 2` policy; a broken slot still fails all three inside ~5min.
- **2026-07-07 quota correction**: the preview cap was reduced 500 → 31.
  Cap 500 helped a single marathon slot, but multiple preview slots at
  `standard-1` exceeded the dev/preview account memory quota and blocked new
  deploys.
- **marathon7** `pvtfkq146g`: 21 clean, run 22 failed in
  `streams-example-app`'s vitest lane: `Network connection lost.` on a
  392ms-old fresh WebSocket (edge blip) — and that suite had NO retry config
  at all. The os lane's `reactivity.spec.ts` flaked the same run and
  recovered via its new `retries: 2`, proving the policy works where it
  exists. Fix: fleet-wide retry parity — `retry/retries: CI ? 2 : 0` added to
  `apps/streams-example-app` (vitest + playwright) and `apps/semaphore`
  (vitest), the last lanes without it.
- **marathon8** `8vl4d0479f`: 🏁 **ALL 50 RUNS GREEN** (14:57–16:31 UTC,
  ~1h34m, ~60-190s/run, zero failures, zero watchdog kills). The goal —
  50 consecutive green full-fleet preview e2e runs on Depot CI — is met, on
  the same afternoon and preview slot where the lane could not string
  together more than a handful of runs when this hunt began.

## Flakes found and fixed

### 1. Leaked semaphore leases starve the slot fleet

Found before the first e2e run: every slot was leased, but pr-1634 and
pr-1636 each held **two** slots while their PR bodies recorded only one. A
deploy run that is cancelled (`cancel-in-progress` on a rapid push) between
the semaphore acquire and the PR-body write leaves a lease no later run knows
about; the next run sees "no lease recorded" and leases a second slot. The
leaked lease blocks other PRs for up to the full lease duration, and their
deploys queue for 20 minutes then fail.

Fix: `claimEnvironmentConfigLease` now adopts any lease the semaphore already
attributes to the holder (re-issued under a fresh leaseId, same pattern as
lease repair) before acquiring a fresh slot. Guard test in
`scripts/preview/preview.test.ts`.

### 2. "The weird JWKS issue": OS teardown bakes JWKS against a parked auth

Failure signature (Depot cleanup jobs, and any run sharing the window):

```
JWKS fetch attempt N failed, retrying: Error: HTTP 503   (x60)
Error: Forge key is set but the deploy-time JWKS fetch from
https://auth.iterate-preview-N.com/api/auth failed (HTTP 503). ... Aborting
```

Preview cleanup destroys all apps in one parallel batch. Auth's teardown
usually finishes first and _parks_ its routes (#1622) — parked routes serve
503\. The OS teardown then ran the deploy-time JWKS bake, whose
`resolveStaticAuthJwks` polls the slot's auth `/jwks` for 120 s before the
forge check aborts the process. Deterministic whenever auth's teardown wins
the race; audited 2026-07-03 Depot runs show it failing exactly that way
(e.g. run kq6qlp02c0, preview-4). The same poll-503-then-abort also shows up
on deploys when the slot's auth is genuinely broken — there it is a symptom,
not the disease.

Fix: the teardown path skips the JWKS bake entirely — a teardown has no
worker to bake a key set into.

### 3. Signup/create-project specs: double navigation redeems the OAuth code twice

The dominant fleet-wide Playwright flake ("locator.fill/waitFor timeout" on
`signup.spec.ts` and `create-project.spec.ts`) renders as a bare page reading
`OAuth callback exchange failed: server responded with an error in the
response body` — after instrumentation (fix below):
`[invalid_verification: Invalid code] (token endpoint HTTP 401)`.

Live worker tails showed the smoking gun: **every** UI login issued TWO
browser navigations to `/api/iterate-auth/callback?code=…` 1–2 ms apart
(adjacent cf-rays, both `sec-fetch-mode: navigate`), producing two
simultaneous token exchanges for a single-use code. better-auth's client ships
a default `redirectPlugin` that auto-navigates whenever a response carries
`{redirect: true, url}` — which `oauth2.continue`/`oauth2.consent` responses
do — while the auth SPA's mutation handlers ALSO `window.location.href =
result.url`. Which exchange wins the D1 row delete and which navigation the
browser commits are independent races, so most runs pass and some render the
loser's 502.

Fixes:

- `apps/auth/src/utils/auth-client.ts`: `disableDefaultFetchPlugins: true` —
  navigation after auth-client calls is now always explicit (the only caller
  that relied on the plugin, Google social sign-in, navigates manually now).
- `apps/auth/src/lib/server.ts`: the callback's 502 now includes the OAuth
  error code + token-endpoint status, so the next exchange failure is
  diagnosable from the Playwright screenshot alone.

### 4. Preview auth signing key changed post-bake (OS static JWKS went stale)

`auth.iterate-preview-2.com/api/auth/jwks` served kid `884xFI…` at 23:12Z and
kid `YDmMHW…` (created 23:22:41Z, mid-e2e, no deploy in flight) later the same
hour — the old row was gone from the `jwks` table while `user` rows survived.
better-auth never deletes jwks rows and no first-party code touches that
table; the strongest correlate is a Depot CI preview deploy that was cancelled
mid-auth-deploy in exactly that window. Root cause unproven; the blast radius
was total (OS verifies with a deploy-time-baked static JWKS, so a post-bake
rotation fails every verification until the next OS deploy).

Mitigation: `createIterateAuth` now falls back to the issuer's live `/jwks`
when the baked set has no matching kid (`ERR_JWKS_NO_MATCHING_KEY`), keeping
the baked set's zero-roundtrip fast path and the forge key intact.

### Lab note: a sleeping laptop perfectly impersonates a broken slot

Two full marathon runs "degraded" for 45–56 minutes with rotating 90 s
timeouts, 14–16 minute per-spec hangs, capnweb `WebSocket connection failed`,
and stream waits that saw events stop mid-flow — while every interactive probe
between runs was healthy. `pmset -g log` showed the Mac cycling through
13–17 minute Deep Idle sleeps exactly matching the hang durations: the loop
was running on a sleeping machine. The loop script now re-execs itself under
`caffeinate -dims` on Darwin. Lesson for anyone chasing "slot degradation" from
a laptop: check `pmset -g log` before blaming the server.

**Recurred round-3 (r3d), new symptom:** an overnight ~5.5h gap between the
warmup and run 1 (the machine slept despite `caffeinate` — a 43-minute
assertion had died) left the preview slot idle long enough that Cloudflare
**de-provisioned the sandbox container image**. When the marathon resumed, a
later run's `sandbox-exec` hit `Container is currently provisioning. This can
take several minutes on first deployment.` (SDK 503, `phase: provisioning`) —
image provisioning exceeded the sandbox test budgets (Playwright
`completionTimeoutMs` 120s, vitest `testTimeout` 240s), failing both attempts.
This is distinct from flake 19's instance-cap "Container is starting": that was
too few slots; this is a cold IMAGE that must be re-pulled after a long idle.
The continuously-running r3c marathon (22 clean) never hit it — **keep the
marathon continuous** (machine awake, no multi-hour gaps) so the image stays
warm. If provisioning latency ever bites a genuinely continuous run, the fix is
to raise the sandbox-exec budgets to tolerate a cold pull, not more warmups.

### 6. Repo reads lose the read-your-write race against the Artifacts remote

`examples-matrix › repo-edit-file` failed with the edit reporting success
(`occurrenceCount: 1`, changed path recorded) while the immediately following
`readFile` returned the **pre-edit** content. The Repo DO clones the
Artifacts git remote fresh for every read, and that endpoint is eventually
consistent after a push — a clone issued milliseconds later can serve the
previous HEAD. Same hazard applied to the worker-source projection refresh,
which could silently bake pre-push worker code even though the commit RPC
already resolved (the DO comments promise "commitFiles() is our
read-your-write boundary").

Fix: the Repo DO records each pushed commit oid per branch
(`repo-pushed-head:<branch>` in DO storage); read clones retry briefly until the
snapshot observes at least that head. (After the #1612 repo refactor this guard
lives in `getFilesSnapshot`, the single clone-and-read pathway every read goes
through; the old per-projection materialization is gone.) See also flake 15 —
serialized writes mean the recorded head can only move forward, never behind our
last push.

### 7. Local harness must match the CI contract (vitest retry)

The e2e vitest lane configures `retry: ci ? 1 : 0` — Depot CI absorbs one
platform blip per test (Cloudflare's DO resets surface as
`internal error; reference = …` / `Durable Object storage caused object to be
reset`, which Cloudflare marks retryable) while the local loop ran with `CI`
unset, i.e. a stricter config than the pipeline being de-flaked. The loop now
exports `CI=true` so a run means exactly what a Depot run means; retried
tests remain visible in the run log.

### 8. CI's vitest retry never actually applied (root config not inherited)

The e2e config declared `retry: ci ? 1 : 0` at the ROOT test level, but
vitest does not inherit `retry` into `projects` configs — a CI-profile run
showed a failed test with zero retry attempts. Every "one retry absorbs a
rare blip" assumption in the preview lane has been a no-op since the config
was split into projects. Fix: `retry` now lives on each project's test block.

### 9. Idle-teardown severance asserted with a 1.5 s deadline

`stream-lifecycle › append after idle teardown re-wakes configured subscriber`
gave the Stream DO 1.5 s to sever three cross-script processor connections
after `runIdleTeardownNow()`. Under the CI-parallel lane profile that
intermittently takes longer; the assertion is about eventual severance, not a
latency SLA. Both severance waits now allow 10 s.

### 10. sandbox-exec REPL spec undercuts the container cold-boot tail

The Playwright REPL spec provisions a fresh project (fresh sandbox container)
per run and middlewright's spinner-waiter caps "spinner still visible" waits
at 30 s — but a cold container boot + repo clone legitimately exceeds that
(observed >70 s across two attempts on preview). `ExampleCase` now carries
`completionTimeoutMs`; sandbox-exec declares 120 s and the spec bypasses the
spinner cap for examples that declare a budget. Expected latency is not a
hang.

### 11. Container-instance cap wedges sandbox starts after ~5 runs

With the fixes above, back-to-back full runs complete in ~1 minute — and both
marathon attempts then failed on exactly run 5, with sandbox-exec consuming
its entire (now 120 s) budget twice: the container never started. Mechanism:
every run provisions fresh fixture projects whose sandbox containers idle for
the SDK-default `sleepAfter = "10m"`, and the sandbox container app is capped
at `maxInstances: 10` — roughly two sandbox containers per run × 5 runs
exhausts the cap, and every later start queues until an old container times
out. Fix: `sleepAfter = "3m"` on the sandbox DO (reclaims capacity ~3× faster;
idle restart costs one cold boot + clone) and `maxInstances: 40` (lite
instances bill on usage, not reservation).

### 12. Green check on a wedged slot: stale failed deploys are never retried

Round 2 opening move. preview_7's D1/KV had been deleted out from under
`envs.ts`, so the first deploy failed (D1 7404). The fix push touched only
`envs.ts` — which was in NO preview paths list — so app selection chose
nothing, the stale `deploy-failed` entries (old head) were excluded by the
retry selector's same-head guard, deploy skipped ("nothing to deploy"), the
test lane skipped its stale recorded apps, and the whole check went **green**
with three apps deploy-failed on the slot. Two fixes:

- `envs.ts` + `scripts/lib/**` joined the preview shared paths (and the Depot
  workflow's `paths`): every app's wrangler config derives from envs.ts.
- Failed states (`deploy-failed`, `claim-failed`, `tests-failed`) now retry
  regardless of which head recorded them; only `awaiting-tests` keeps the
  same-head guard.

### 13. Fresh-worker bring-up: module-scope config parse + orphaned container app

Recreating preview_7's deleted workers surfaced two first-deploy failures:

- **semaphore**: `parseConfig(workerEnv)` ran at module scope, so Cloudflare's
  upload-time script validation threw ZodError on a worker with no secrets
  yet — rejecting exactly the classless bootstrap deploy a fresh worker needs
  before its first code+secrets version (deploy-helpers.ts). The parse is now
  lazy (memoized on first request).
- **os**: the Cloudflare _Containers application_
  `os-preview-7-cloudflaresandboxdurableobject-preview_7` survived the old
  worker's deletion and stayed bound to the dead DO namespace; redeploying
  created a new namespace and Cloudflare refused the collision ("already an
  application with the name … associated with a different durable object
  namespace"). Fixed operationally with `wrangler containers delete <id>`;
  if a slot's os worker is ever deleted again, expect this and delete the
  orphaned application before redeploying.

### 14. Vitest wedged at startup for 9+ hours (loop watchdog added)

Round-2 run 14: the Playwright specs passed, then `pnpm e2e --project node`
printed vitest's header and nothing else for 9h23m. The vitest main process
sat with an idle event loop (kevent wait), zero CPU, and **no worker
children** — it hung before running a single test, machine awake the whole
time (`pmset` clean). Root cause unknown (one occurrence in ~20 runs;
plausibly a wedge in vitest's startup/fork-pool against this Node version).
Mitigation: the loop now runs each attempt under a watchdog
(`RUN_TIMEOUT_SECS`, default 30 min) that kills the run tree and counts it as
a failure instead of silently freezing the marathon.

**Recurred round-3 (r3c run 23), and exposed two gaps — both now fixed:**

- The watchdog fired at 30 min but its `SIGTERM` did **not** propagate down the
  deep `doppler → pnpm → trpc-cli → inner doppler → bash → vitest` tree, so the
  wedged run hung ~58 min past the timeout, still holding the loop's `wait`.
  Fix: the watchdog now walks the whole descendant tree and `SIGKILL`s it
  leaf-first (`kill_tree` in `flake-hunt-loop.sh`).
- More importantly, the wedge is now **self-healing at the source** instead of
  costing a whole run: the preview test orchestration (`previewTestCommandArgs`
  in `preview.ts`) wraps the vitest node lane in `timeout` and retries it once
  on a timeout. A rare fork-pool wedge is a fresh restart, not a dead lane — and
  this fixes it for Depot CI too, where the same wedge would otherwise hang the
  job until its timeout. Root cause (why vitest's pool occasionally hangs
  pre-`RUN`) is still unknown; this makes it a non-event either way.

**Correction (first Depot marathon, run df87f12sz3): the self-heal was firing
on EVERY run.** The retry condition also fired when the lane "never printed
`RUN v<version>`" — but that grep is defeated by vitest's ANSI colour codes,
which sit _between_ `RUN` and the version (`RUN␛[…m␛[…mv4.1.8`), so it matched
nothing and re-ran the entire vitest node lane a second time on every single
run (all 18 of them). That silently **doubled test load and sandbox-container
churn** — very likely a hidden aggravator of flakes 19/20 (cap pressure and
provisioning latency) throughout round 3. Fix: retry **only** on `rc=124` (the
timeout — the actual wedge signature); `rc=0` means it ran, and a non-124
non-zero is a real failure we must not paper over. Also cut the lane `timeout`
to a fail-fast 360s (was briefly 600/900).

### 15. Concurrent repo writers lose the compare-and-swap race on `refs/heads/main`

Round-2 run 44 (43 consecutive greens, then this): `examples-matrix ›
repo-edit-file` failed two different ways across its retry — first a
`git.push` **`GitPushError: refs/heads/main: stale ref`**, then (on the retry)
the final `readFile` returning `status: draft` after the edit had reported
success. Both are the same root cause.

The itx examples matrix runs many repo-mutating examples
(`repo-commit-files`, `repo-edit-file`, …) **concurrently against ONE shared
project repo**, all pushing to `refs/heads/main`. Each mutation clones HEAD,
commits on top, and pushes. The Artifacts git server enforces optimistic
concurrency (compare-and-swap on the ref): when a second writer's push carries
a parent that is no longer the server's current HEAD — because the first
writer landed in between — the server rejects it with `stale ref` /
not-fast-forward, and isomorphic-git surfaces that as a thrown `GitPushError`.

`force: true` (which every mutation used) does **not** help and actively hurt:

- It only skips isomorphic-git's _client-side_ fast-forward check, not the
  _server's_ compare-and-swap — so the `stale ref` rejection still happens.
- A force-push that _did_ land would clobber the concurrent writer's commit by
  resetting HEAD to a parent that predates it. That is exactly how the second
  failure arose: our `edit` committed and pushed, then a racing writer's
  force-push reset `main` to a commit that predated our edit, and the
  read-your-write clone (flake 6) faithfully returned the reverted content.

Fix: **already solved on main by the #1612 repo refactor**, which this branch
merges — so the standalone fix this branch first carried (a compare-and-swap
retry loop in `mutateArtifactRepo`) was dropped in favour of main's cleaner,
structural one. The Repo DO now serializes every write through a `#writeChain`
(`commitFiles`/`edit` each run inside `#serializeWrite`), so two mutations to one
repo can never be in flight at once: each clones the latest HEAD, commits, and
fast-forward pushes with **no `force`**. With a single writer at a time there is
no compare-and-swap race to lose and no force-push to clobber a concurrent commit
— the two failure modes above are structurally impossible. (`seedArtifactRepo`
keeps its one force-push: it runs once at repo creation, never concurrently.)
The diagnosis is retained here because it explains _why_ main dropped `force` and
serialized writes; the marathon re-verifies it end-to-end.

### 16. Marathon methodology: an incremental deploy splits the fleet head

Not a product flake — a hole in the flake-hunt harness, surfaced while shipping
the flake-15 fix. `preview deploy` selects apps by diffing the PR head against
the **last deployed head**, not the PR base. So a mid-branch commit that touches
only one app (the flake-15 fix was `apps/os`-only) redeploys just that app and
leaves the others at the previous head. The test lane only tests apps whose
recorded head equals the PR head, so the very next marathon run tested `os, auth`
but not `semaphore, streams-example-app` — tripping the full-fleet guard
(exit 3) at run 1. This is the deploy-side twin of flake 12: a fleet can silently
shrink to the changed apps, and without the guard a partial lane would count as
green.

Fix (`scripts/preview/flake-hunt-loop.sh`): a fresh marathon (`START_AT=1`) now
runs a full-fleet deploy preflight before counting runs and refuses to start on
a `deploy-failed`/`claim-failed` app (exit 4). Because `scripts/preview/**` is a
preview shared path, any change under it (envs.ts and scripts/lib/\*\* too) forces
`preview deploy` to redeploy the whole fleet, reunifying the head — so the
preflight both guarantees a unified fleet and repairs a split one. Set
`SKIP_PREFLIGHT_DEPLOY=1` when resuming a marathon whose fleet is already unified.

**Preflight hardening (round 3):** the preflight originally relied on the
marathon commit happening to touch a fleet-shared path to force a full-fleet
deploy — an apps/os-only commit would have deployed just os and tripped the
guard at run 1. `preview deploy --all-apps` now forces the full fleet
explicitly and the preflight uses it.

**Second sub-cause (round 3):** a commit touching only dependency manifests
(`patches/**` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`, from the flake-22
middlewright patch) selected **no apps at all** — "nothing to deploy" left
every recorded head stale behind the PR head and the test lane skipped every
app. Dependency manifests can change any app's build output, so they are now
`cloudflareAppSharedPaths` (full-fleet deploy), mirrored in
`cloudflare-previews.yml`'s paths filter and asserted in `preview.test.ts`.

### 17. A second browser tab has no spinner-waiter, so it dies on the 750ms actionTimeout

Round-2 (r2e) run 3: `reactivity.spec.ts › delivers an appended event to another
open tab` failed on the initial attempt **and** retry #1 —
`TimeoutError: locator.waitFor: Timeout 750ms exceeded` waiting for the second
tab's `reactivity-stream-status` to read `live`. The first tab (line 73) went
live fine; only the second tab (line 74) timed out.

`playwright.config.ts` sets a deliberately tight `actionTimeout: 750` (non-video)
so bare `waitFor()`s fail fast; the safety net is middlewright's spinner-waiter,
which **extends** a wait up to ~28s while a `data-spinner="true"` element is
visible. The reactivity page shows exactly one such element (the "connecting…"
badge) while a subscription connects, so the primary page reliably reaches
`live`. But the second tab is created with `context.newPage()`, which returns a
raw page **without** our middlewright plugins — so its `waitFor()` gets only the
raw 750ms, too short to open a second concurrent stream subscription (a second
WebSocket to the same Stream DO). Runs 1–2 passed because the second tab
happened to connect in <750ms; run 3 it didn't, twice.

Fix (`specs/test-support/test.ts`, not the spec — specs stay verbatim): the
`page` fixture now patches `context.newPage` to wrap every subsequently-opened
page with the same plugins as the primary. `basePage` already exists when the
fixture runs (Playwright's built-in `page` fixture created it via
`context.newPage()` first), so the primary page is never double-wrapped; only
extra tabs the spec opens later get wrapped. Any multi-tab spec now benefits.

### 18. A dangling stream-wait rejection crashes the vitest runner, bypassing `retry: 1`

Fleet survey (2026-07-04, across all of today's PRs) found the stream-event
delivery flake was the dominant preview e2e failure (4 of 5 failing PRs), and
uncovered a distinct, higher-leverage bug in _how_ it fails. On PRs #1664 and
#1665 the `Timed out waiting for stream event … saw 0 events` error came back
over capnweb's read loop (`serialize.ts` → `rpc.ts` `readLoop`) as an
**unhandled promise rejection** — not inside a test's `await` — and Node's
default crashed the whole vitest worker (`Node.js v24…`, exit 1, **zero test
output**). Because the process died before vitest could mark the test failed,
the CI `retry: 1` safety net never engaged. The same flake on #1666, where it
surfaced inside an `await`, recovered on retry and went green.

Why it dangles: under `sequence.concurrent` (maxConcurrency 2) several tests'
`waitForEvent` RPCs are in flight at once. When the slot's stream delivery
stalls under load, a sibling test's — or a background subscription's — wait
rejects after its owning test has already moved on, so nothing is awaiting it.

Fix (`apps/os/e2e/vitest/setup.ts`): a scoped `unhandledRejection` handler that
swallows **only** the known-transient stream-wait signature
(`Timed out waiting for stream event` / `waitUntilEvent timed out`) so the
worker survives — the test that actually awaited the wait still fails normally
and `retry: 1` re-runs it — and re-throws every other rejection (Node escalates
that to an uncaughtException, preserving crash-on-real-bug). This converts a
suite-killing crash into an ordinary, usually retry-absorbed, failure.

The survey also **refuted the "unhealthy preview slot" hypothesis**: today's 5
failures spread evenly across preview-2/-3/-4/-7/-9 with no repeated or
chronically-bad slot and zero JWKS/503/`workers.dev`-edge-drift; the only
environmental correlate is cold-slot / cold `WORKER_BUILD_CACHE` on the first
run after a deploy. And it confirmed `maxConcurrency: 2` still flakes, so the
real fixes remain the tracked delivery race
(`tasks/streams-event-delivery-flake-under-concurrent-load.md`) and splitting
the 39-test `itx.e2e.test.ts` monolith — **not** raising concurrency.

### 19. Sandbox container instance-cap wedge (`Container is starting`)

Round-3 (r3b) run 4: `sandbox-egress.e2e.test.ts › is MITM-intercepted and
routed through project egress` failed **both attempts** (~292s) with
`Error: Container is starting. Please retry in a moment.` — the SDK's own
transient-startup 503, which it auto-retries, but the container never became
ready inside the budget, twice. This is the flake-11 family resurfacing: the
preview slots capped sandbox containers at `max_instances: 20`, and
sandbox-heavy e2e churns several fresh containers per run (the REPL
`sandbox-exec` spec, #1654's new `sandbox-egress` vitest test, the examples
matrix — each a fresh project + container), so under a marathon the cap is
reached and a new container wedges in "starting" until a slot frees.

Cleanup was **not** the problem: the `@cloudflare/containers` base sets a
durable idle alarm from `sleepAfter` (3m) and `CloudflareSandboxDurableObject`
does not override `alarm()`, so every idle container is reaped and its slot
freed within ~3m (verified in the SDK: `renewActivityTimeout` → `sleepAfterMs`
→ `alarm()` stop). The containers were being cleaned; there just weren't enough
slots for the churn rate.

**Correction (flake 23):** the SDK verification above proved the container
_stops_ — not that its instance slot is _released_. It isn't: a stopped
instance stays ASSIGNED to its Durable Object and assignments are what count
against `max_instances`. The cap raise bought headroom but the leak remained;
see flake 23 for the real fix (destroy on idle).

Fix (`apps/os/scripts/generate-wrangler-config.ts`): raise the cap to **100**
for previews and **50** for prd (`lite` instances bill on usage, not
reservation, so a high cap is free headroom). The durable idle reaper keeps
cleanup reliable at any cap. Also added `WARMUP_RUNS` to
`scripts/preview/flake-hunt-loop.sh`: a freshly-deployed slot boots cold (os
worker + DO chain + sandbox containers on first use), so the marathon can run N
uncounted priming runs before counting, keeping a cold run 1 from resetting the
streak.

### 20. Sandbox tests must budget for cold container image provisioning

Distinct from flake 19's instance-cap "Container is starting": Cloudflare
intermittently RE-PROVISIONS the sandbox container image
(`Container is currently provisioning. This can take several minutes on first
deployment.`, SDK 503 `phase: provisioning`). It hit r3d run 7 (after an
overnight idle) **and** r3e run 17 — the latter on a **continuously-running**
marathon ~40 min / 16 clean runs in, so it is NOT just a post-idle artifact: the
image gets re-pulled to a node every ~15-20 runs regardless. When it fires it
hits every sandbox test at once (`sandbox-exec` in both the vitest matrix and
the Playwright REPL lane, plus `sandbox-egress`), and the SDK's automatic retry
takes longer than the old 120-240s test budgets, so they time out mid-provision.

The first instinct was to raise the budgets to ride provisioning out (480s
tests, 900s lane). **That was wrong and has been reverted.** Sitting for 8-15
minutes to mask a Cloudflare infra transient is worse than failing: it hides a
real issue behind a huge wall-clock, and the point of the e2e lane is to
**fail fast when something is actually wrong**. The provisioning latency is a
Cloudflare-side transient (a direct `itx run` sandbox probe confirmed it clears
on its own — a fresh sandbox exec returned in seconds once the window passed),
not something the test should absorb.

Decision: keep **fail-fast** budgets — `sandbox-exec` `completionTimeoutMs`
180s (120s undercut a genuine ~132s cold boot observed on Depot), the vitest
matrix/`sandbox-egress` tests 240s, and the `preview.ts` vitest-lane guard 360s
(was briefly 600/900). A container stuck provisioning
surfaces in ~2 min and the run fails; we re-run rather than wait. Reaching 50
consecutive green therefore depends on a healthy provisioning window (or a
Cloudflare-side fix), not on masking the latency — and CI’s own retry absorbs a
lone transient. If provisioning proves _frequent_ enough to block 50-in-a-row,
the right lever is reducing sandbox-container churn or a Cloudflare escalation,
not a bigger timeout.

### 23. Stopped sandbox containers never release their instance slots

**Signature** (Depot marathon3 run 12, and retroactively flakes 19/20): runs
slow down progressively (sandbox-exec 22.7s → 33.8s → stuck at 180s×2), the
vitest lane trips its 360s guard, the loop watchdog SIGKILLs the run at 600s.
The REPL page shows the run submitted but the entry never lands — the
server-side sandbox exec is silently waiting for a container that never
starts. No error anywhere.

**Root cause:** `wrangler containers info` on preview-3 fifteen minutes after
the marathon died: `instances: {active: 0, assigned: 99, healthy: 1}` — at the
`max_instances: 100` cap — while idle slots hold 7-10 assignments for **days**.
The SDK's `sleepAfter` idle alarm does run (`active: 0` — the containers
stopped), but a stopped instance stays **assigned** to its Durable Object, and
assignments (a) count against `max_instances` and (b) never expire on their
own — only `destroy()` or an app rollout releases them. Every e2e fixture
creates a fresh sandbox DO, so each preview e2e run leaks ~7-8 assignments;
the cap wedges after ~a dozen runs; a fleet deploy resets the count (which is
why every marathon ran clean for its first ~dozen runs and why flake 20's
"provisioning windows every 15-20 runs" pattern fit so well — it was this
leak, not image re-pulls, at least in the continuously-running cases).

**Fix (`cloudflare-sandbox-durable-object.ts`):** override
`onActivityExpired` to `destroy()` (SIGKILL + full teardown, releases the
assignment) instead of the SDK's `stop()` (SIGTERM, keeps the assignment).
For our sandboxes destroy-on-idle costs nothing: the container filesystem is
ephemeral across sleep anyway, so waking from stop and waking from destroy are
the same cold boot + repo re-clone. The SDK's keepAlive escape hatch is
preserved. Verified on preview-3 with a probe sandbox (`itx.sandboxes.get` +
one exec): its instance showed `active:1, assigned:0` while running and went
`active:0, assigned:0` exactly 3m after the last command — the slot fully
released, where the old behavior left it `assigned` indefinitely. (The fix's
deploy also confirmed a rollout flushes the leaked pool: the app dropped from
100 stuck instances to a handful once the new version finished provisioning.)

**Marathon5 addendum — destroy is necessary but the cap must still exceed
cumulative churn.** With destroy-on-idle deployed, marathon5 still wedged at
run 33 with `active:0, assigned:100`: under sustained load the platform
BACKFILLS released slots into an "assigned" warm pool that rides at
`max_instances` (the probe above released to 0 only because demand was zero
at that moment), and sandbox start latency grows as the pool saturates —
sandbox-exec went ~20-40s (runs 1-10) → 2.1-2.8min (runs 30-32, shaving the
180s budget) → 3.2m×2 attempts (run 33, dead). Every marathon wedge to date
happened at exactly `assigned == max_instances` (20, then 100). Response:
preview cap raised 100 → **500** (`generate-wrangler-config.ts`) so a whole
50-run marathon's cumulative creations (~3-8 sandboxes/run) never saturate
the pool. On 2026-07-07 this was reduced to **31** because several preview
slots at 500 `standard-1` instances exceeded the dev/preview account memory
quota and blocked deploys; 31 standard-1 instances fit the same quota as the
old 500-lite cap. Destroy remains correct — it is what lets an idle fleet drain
back to zero instead of holding slots forever. If sustained-churn claim latency
reproduces near the deployable cap, this becomes a Cloudflare Containers
escalation (pool-manager degradation under DO-binding churn), not an app-side
fix.

### 21. Blank route-pending panel fast-fails the first wait after `goto`

**Signature** (Depot marathon2 run 5; also the round-2 merge's own preview
e2e — the "REPL Run button fast-fail" below): `repl-examples.spec.ts`
`repo-read-file` / `repo-edit-file` fail in ~6s with
`TimeoutError: locator.waitFor: Timeout 1ms exceeded` waiting for the "Run"
button right after `page.goto(/projects/<slug>/repl)`. The failure screenshot
shows the app shell (sidebar, breadcrumb) with a **completely empty main
panel** — no REPL, and critically no spinner.

**Root cause — a product gap, not a slow test.** The project layout
(`routes/_app/projects/$projectSlug/route.tsx`) is `ssr: false`, so a direct
hit SSRs only the shell; TanStack renders the client-only match as
`<ClientOnly fallback={pendingElement}>` and shows `pendingElement` again
while `beforeLoad` (the `getProjectBySlugServerFn` HTTP roundtrip) runs after
hydration. The router configured **no `defaultPendingComponent`**, so
`pendingElement` was `null` → the outlet rendered literally nothing for the
whole hydrate + project-fetch window. The failing trace shows that server-fn
taking **1037ms** (a normal cold-read tail); with no spinner visible the
spec-side spinner-waiter correctly refused to extend the deliberately-tight
750ms actionTimeout and the wait died with 1ms left. All the route-level
fallbacks further down (`ItxResourceLoading`, `ItxPending`) never got a chance
to render — the match itself hadn't mounted.

**Fix (apps/os/src/router.tsx):** wire `defaultPendingComponent` (muted
"Loading…" with `data-spinner="true"`, same idiom as every route-level pending
fallback) plus `defaultPendingMs: 300` / `defaultPendingMinMs: 200` (library
defaults leave a 1s blank window on client-side loads). The spinner now sits in
the SSR HTML itself for `ssr: false` subtrees, so from first paint to REPL
mount the app continuously reports progress and the spinner-waiter extends
exactly as designed — no spec-side timeout was touched. This is the correct
fail-fast shape: the wait budget grows only while the app visibly claims to be
working, and a genuinely wedged page still dies at the spinner-waiter's 30s
cap.

### 22. spinner-waiter dies on TWO visible spinners (strict-mode violation)

**Signature** (the push-triggered preview run for the flake-21 fix):
`dashboard.spec.ts` fails with `locator.isVisible: Error: strict mode
violation: locator('[aria-label="Loading"],[data-spinner=…]…') resolved to 2
elements`.

**Root cause:** middlewright's spinner-waiter checks "is a spinner visible?"
with `spinnerLocator.isVisible()` on the UNION selector — and Playwright's
`isVisible()` throws when a locator resolves to more than one element. Two
loading indicators visible at once is a perfectly legitimate app state (e.g.
the REPL panel's "Connecting to itx…" next to the activity tail's "Connecting
itx activity…"). The flake-21 fix UNMASKED this: before it, the blank pending
panel meant those sibling fallbacks never got to render together during the
window the spinner check runs in.

**Fix:** `patches/middlewright@0.1.1.patch` — both spinner checks
(`spinnerVisible` and the bail-early check in `waitForReadyWhileSpinning`) go
through a multi-element-safe `anySpinnerVisible()` using
`filter({ visible: true }).count() > 0`, which needs no strictness. "Any
visible spinner counts as progress" is the plugin's intended semantic. Worth
upstreaming to the middlewright package.

### Round 3 targets

The round-2 merge commit's own preview e2e (Depot, two attempts) failed on two
pre-existing flakes that round 3 fixes:

- **REPL "Run" button fast-fail.** `forged-session-repl.spec.ts` and several
  `repl-examples.spec.ts` cases fail with `Timeout 1ms exceeded` waiting for
  `getByRole("button", { name: "Run" })` after `/repl` navigation. Root-caused
  as **flake 21** (blank route-pending panel — no `defaultPendingComponent` on
  an `ssr: false` subtree), fixed in `router.tsx`.
- **Stream-event delivery timeout under concurrent load / cold build cache.**
  `Timed out waiting for stream event after 60–90s (saw 0 events)` across
  reactivity, repl-examples, and a vitest e2e test. Known/tracked
  (`tasks/streams-event-delivery-flake-under-concurrent-load.md`,
  `tasks/raise-e2e-maxconcurrency.md`); the vitest lane already runs at
  `maxConcurrency: 2`. The round-2 merge added #1612's worker-build pipeline,
  whose first dynamic-worker build on a **cold `WORKER_BUILD_CACHE` KV** (freshly
  created per slot) adds latency that widens this window on the first run.

### Observed, not yet fixed

- **Push-lane deploy→test race: `Durable Object reset because its code was
updated`.** The push-triggered cloudflare-previews lane starts tests seconds
  after `wrangler deploy` returns; Cloudflare propagates the new code
  asynchronously, and a DO that booted on the old version mid-test gets reset
  when its node picks up the new one (`itx.e2e.test.ts › Project egress
intercept…` failed BOTH vitest attempts 11s apart inside the window, commit
  204d4ed8d). The marathon lane is immune by construction (preflight deploy →
  uncounted warmup → counted runs). A real fix for the push lane would gate
  the test phase on observing the new deployment version at the edge rather
  than a sleep; vitest's `retry: 1` usually absorbs it today.
- `packages/mock-http-proxy` unit test `msw-server-adapter.http-parity ›
does not mark non-matching one-time handlers as used` failed once in the
  Depot `Test / test` lane with `fetch failed: bad port` — the listen(0)
  helper appears to have produced port 0 despite waiting for 'listening'.
  Unit lane, outside preview e2e; needs its own repro.
- One Depot push (`346bcebdb`) produced a run with **zero scheduled
  workflows** (`depot ci status` shows `"workflows": []`), so no checks were
  created for that head at all; a manual `depot ci dispatch` of
  cloudflare-previews.yml covered the gap. Worth watching for recurrence.

### 5. Sandbox repo clone dies on a transient Artifacts 503

`repl-examples.spec.ts › sandbox-exec` failed with `Failed to clone repository
'https://…artifacts.cloudflare.net/git/…': error: 503` — the Artifacts git
endpoint intermittently 503s on cold repos and the sandbox clone ran exactly
once. Fix: `cloudflare-sandbox-durable-object.ts#cloneProjectRepo` retries the
clone (3 attempts, backoff, fresh target dir each try).
