# Preview e2e flake hunt

Goal: run the full preview e2e lane against a real preview environment 50
times in a row without a single flake, fixing and documenting every failure
encountered along the way.

Round 1 (PR #1644) found and fixed nine root causes (below) and merged them
to main. Round 2 continues the consecutive-green-run count on this PR against
the post-de-alchemization (#1636) deploy model.

Method: deploy this PR's preview slot, then loop
`doppler run --project _shared --config prd -- pnpm preview test --pull-request-number <N>`
from a workstation. Every failure gets a root-cause diagnosis and the smallest
reliable fix, recorded below. A failure resets the consecutive-green counter.

## Run log

(populated as runs complete)

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
[alchemy.run] JWKS fetch attempt N failed, retrying: Error: HTTP 503   (x60)
Error: [alchemy.run] Forge key is set but the deploy-time JWKS fetch from
https://auth.iterate-preview-N.com/api/auth failed (HTTP 503). ... Aborting
```

Preview cleanup destroys all apps in one parallel batch. Auth's teardown
usually finishes first and _parks_ its routes (#1622) — parked routes serve
503\. The OS teardown then runs `apps/os/alchemy.run.ts`, whose top-level
`resolveStaticAuthJwks` polls the slot's auth `/jwks` for 120 s before the
forge check aborts the process. Deterministic whenever auth's teardown wins
the race; audited 2026-07-03 Depot runs show it failing exactly that way
(e.g. run kq6qlp02c0, preview-4). The same poll-503-then-abort also shows up
on deploys when the slot's auth is genuinely broken — there it is a symptom,
not the disease.

Fix: `alchemy.run.ts` skips the JWKS bake entirely when invoked with
`--destroy` — a teardown has no worker to bake a key set into.

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
`caffeinate -is` on Darwin. Lesson for anyone chasing "slot degradation" from
a laptop: check `pmset -g log` before blaming the server.

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
(`repo-pushed-head:<branch>` in DO storage); read clones and the
worker-source materialization retry briefly until the snapshot observes at
least that head. A concurrent writer can legitimately advance HEAD past the
recorded oid (its commit stacks on top of ours — see flake 15), so after the
bounded retries the latest snapshot is served regardless; because writes are
now fast-forward-only, that later snapshot always still contains our commit.

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

Fix (`repo-durable-object.ts` `mutateArtifactRepo`): stop force-pushing, and
wrap the whole clone→mutate→commit→push cycle in a compare-and-swap retry loop
(8 attempts, jittered backoff). On a concurrent-push rejection
(`isConcurrentPushRejection`, unit-tested in `utils.test.ts`) it re-clones the
latest HEAD and re-applies the mutation, so concurrent writers **stack** their
commits and serialize cleanly instead of clobbering each other. Fast-forward-only
pushes also mean flake 6's read guard can never observe a HEAD that dropped our
commit. `seedArtifactRepo` keeps its force-push: it runs once at repo creation,
never concurrently.

### Observed, not yet fixed

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
