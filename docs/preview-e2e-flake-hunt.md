# Preview e2e flake hunt

> This document is the evidence log — every flake, root cause, and marathon
> run. The **policy** distilled from it (one retry layer, watchdog sizing,
> retry telemetry) lives in [testing.md → Retries and
> timeouts](testing.md#retries-and-timeouts).

Current goal: run the complete preview pipeline against a real preview
environment 25 times in a row without a single failure, with every full-fleet
deploy plus e2e run completing in under five minutes and without an absorbed
test retry. Fix and document every failure, retry, or tail encountered along
the way.

Round 1 (PR #1644) found and fixed nine root causes and merged them to main.
Round 2 (PR #1653, merged) added flakes 16–17 and the `preview.ts` lease/retry
hardening, and merged main's worker-build pipeline (#1612) — whose `#writeChain`
write serialization supersedes round 2's standalone flake-15 fix. Later rounds
repeat the same proof after substantial platform changes and record their exact
base revision, run IDs, and findings below.

Method: `scripts/preview/flake-hunt-loop.sh` sequentially dispatches the
canonical Depot `cloudflare-previews.yml` workflow. Every iteration is a normal
fresh-runner preview check—full-fleet deploy, every e2e lane, artifact upload,
GitHub timing, and PostHog telemetry—not a second implementation hidden inside
one long-running job. It fails fast on the first functional failure, moved
head, absorbed retry, or run at or above five minutes, and writes a
machine-readable ledger containing the immutable head plus Depot run/attempt
IDs, whole-run duration, and retry count. Every failure, retry, or tail gets a
root-cause diagnosis and the smallest reliable fix; any of them resets the
consecutive-clean counter.

This zero-retry acceptance rule applies to new proof runs from 2026-07-22
onward. Historical ledgers below retain the semantics and retry counts they
recorded at the time; they are evidence, not retroactively relabelled runs.

Once a failing test is isolated, use `pnpm preview test-target` to run its
Vitest file or Playwright spec repeatedly against the PR's already-deployed
preview. It does not deploy, erase, or overwrite the full-suite result; see
[Dev environments → Story 2](dev-environments.md#story-2-run-what-ci-runs-locally)
for exact commands. This focused loop is diagnostic only: the accepted streak
still consists of complete deploy-plus-e2e runs on Depot.

Run the orchestrator from an authenticated workstation:

```bash
PR_NUMBER=<pr> REF=<branch> RUNS=25 ./scripts/preview/flake-hunt-loop.sh
```

The workstation only dispatches and observes. Every counted attempt executes
independently in Depot on the normal preview job's 16-core runner and sends the
normal telemetry; if the workstation sleeps or exits, no running test is
misclassified and no later run is silently counted. Resume by explicitly
starting a new proof—accepted streaks are never inferred across ledgers.

## Round 12 (2026-07-23, post-#2269)

This round starts from `origin/main` at
`c5d51cf02e0c1acf9a36bec903ecf956ae9469ae`. PR #2269 paid off three
independent sources of preview tail latency and absorbed retries:

- project-directory registration now retries only the missing slug or
  project-index write, so a partial KV failure cannot replay a successful
  sibling write;
- onboarding smoke consumes the deployment-wide rollout deadline immediately
  before project creation instead of beginning a second rollout wait; and
- stream-backed read-your-writes paths no longer perform an unbounded,
  redundant processor catch-up before entering the existing offset wait that
  owns the explicit 15-second deadline.

The final exact-head check for #2269 ran all five app suites in 231 seconds with
zero retries: Depot run `b2jwhtx6q4`, attempt `nvg49cr0jp`. OS Playwright passed
63/63 and the formerly retrying repository-edit and secret write-fence cases
both passed on their first attempts. PostHog recorded 310 preview logical-test
outcomes and 3,046 unit outcomes with zero failures or retries, and both
telemetry finalizers reported complete expected source coverage. Cloudflare
traces showed no wall-time exhaustion, resource exhaustion, or unexplained
Durable Object reset in the test window.

That run was PR acceptance evidence before the squash merge, not part of this
post-merge consecutive proof. The round-12 counter therefore starts at 0/25 on
this new immutable PR head.

## Round 11 (2026-07-23, post-#2265)

This round starts from `origin/main` at
`56fdbd4e447ab53f3011a60417349f76223db30d`. PR #2265's final exact-head
canonical check ran all five suites successfully in 291 seconds from pickup to
finish (the GitHub check itself reported 4m40s): Depot run
[`79jc4l57lt`](https://depot.dev/orgs/0p91s0lz49/workflows/37tr66gdxx?job=nk8k8jvb81),
attempt `c2mnb0ph28`. Playwright had zero retries, but OS Vitest absorbed one,
so this is a useful ordinary green and a rejected formal proof; the accepted
counter remains 0/25.

The retry was `itx expression replacement records the recipe without
evaluating it`. Its first attempt failed during fresh-project creation with
`stream-unavailable: Durable Object is overloaded. Requests queued for too
long.`; the full-test retry created a second project and passed. PostHog records
153 executions of this exact case over the preceding 30 days and only this one
retry (0.65%). Duration was normally 9.0s at p50 and 14.9s at p95; the retried
run took 19.3s. That history does not justify quarantine, serialization, or
project reuse.

Cloudflare traces locate the first failure in project
`prj_d2cb39d19139488fba1c5236b17d61da`, not in deployment-global state. Its
root Project Durable Object repeatedly rejected delivery while
`ProjectProcessor.#createSiblingProcessors` waited for the root capability-host
birth. The stream sink durably backed off and re-poked the subscription, and
the same project subsequently reached ready about nine seconds after
registration. The caller nevertheless failed earlier: the processor relay
performed its one immediate lifecycle retry, received another availability
rejection, and threw even though `waitUntilProcessed` still had most of its
75-second public deadline available.

The round-11 fix makes only that idempotent wait operation reacquire a fresh
processor facade after repeated availability failures. It retains one caller
deadline, applies exponential backoff capped at one second, disposes every
transient facade, and fails when the deadline expires. Application errors still
propagate immediately, and non-wait processor calls keep their existing single
retry. Focused tests cover recovery after more than two availability failures,
decreasing timeout propagation, application-error fail-fast behavior, and
bounded exhaustion. This pays off the product-layer wait contract instead of
adding a test retry, longer timeout, quarantine, or global Vitest throttle.

## Round 10 (2026-07-23, post-#2263)

This round starts from `origin/main` at
`7b41300708f49146603fea09766fca64a07f1eb8`, including the lazy repository lane
from PR #2262. PR #2263 fixed the false-green
boundary exposed by PR #2262: a head that selected no deployment work reused an
older head's test result and returned success in six seconds. Deployment reuse
is still allowed, but every triggered PR head now executes every runnable app
suite against the exact recorded Worker versions. An empty runnable set fails
loudly with `E2e was NOT run` instead of becoming a skipped success.

The repaired #2262 check at head `1ef0f722…` performed all five app suites and
passed in 3m37s with zero retries. Its later head `6f1d610f…` then provided an
important real failure rather than another false green: Playwright and all
non-OS suites passed, while six OS Vitest cases retried and one still failed.
The failures spanned unrelated project, agent, MCP, egress, worker-readiness,
and sandbox cases. One error explicitly said `Durable Object reset because its
code was updated`; another script execution was orphaned because its
incarnation disappeared. All affected tests owned distinct projects.

PostHog places the OS deploy-phase finish at `23:05:30.758Z` and the Vitest
start at `23:05:51.367Z`: only 20.6 seconds separated edge readiness from the
full fan-out. Exact-version readiness itself took 58ms. The explicit reset
arrived about 51 seconds after Wrangler uploaded the version. Cloudflare's
[known-issues documentation](https://developers.cloudflare.com/durable-objects/platform/known-issues/)
says Worker/DO code propagation is globally eventually consistent for seconds
to minutes, while the
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
documents that a code update shuts an object down and can terminate in-flight
RPC. Exact edge-version health is therefore necessary but cannot certify every
future Durable Object placement.

A control on the next #2262 head, `410c1774…`, was genuinely green in 3m48s:
all five suites ran, OS Playwright passed 63/63, OS Vitest passed all 170
reported cases, and raw telemetry recorded zero retries. On that run OS
readiness naturally consumed 31.1 seconds before the smoke's 22.6-second path
to Vitest, giving the deployment about 53.7 seconds of age before fan-out. That
does not prove 54 seconds is a safe boundary, but the contrast localizes the
failure cluster to the fresh global-rollout window rather than shared project
state or one victim test.

Round-10 preflight ledger:

| Proof                     | Revision                                   | Accepted runs | Retries | Outcome                                      |
| ------------------------- | ------------------------------------------ | ------------: | ------: | -------------------------------------------- |
| Repaired #2262 full check | `1ef0f722…`                                |          0/25 |       0 | Real five-suite pass in 3m37s                |
| Fresh-rollout failure     | `6f1d610fdea1521ca93a6e5c4a3bcdee203e5dc0` |          0/25 |       6 | OS Vitest failed after rollout-reset cluster |
| Natural-readiness control | `410c1774d8b0a614096d89dcfe39c1e44359a9b6` |          0/25 |       0 | Real five-suite pass in 3m48s                |

The smallest deterministic CI boundary is a 90-second minimum age from the
successful OS deploy command to high-fanout Vitest. The clock starts before
exact-version readiness and runs concurrently with readiness, onboarding
smoke, Chromium installation, Playwright, TUI, and every other app suite;
reused older deployments wait zero seconds. Playwright remains on the critical
path in the observed runs, so the clock should add little or no wall time. This
is a visible bounded lifecycle gate, not a retry, test quarantine, synthetic
Durable Object sampler, or serial deployment barrier. The accepted counter
remains 0/25 until the new immutable PR head completes the canonical marathon.

The first formal head then passed four consecutive full runs in 231–241
seconds with zero retries. Run 5 took 361 seconds and was rejected because two
Playwright cases needed their permitted retry. Both failed before their named
stimulus: one fresh onboarding feed never painted its greeting, and one REPL
case timed out inside project creation. Cloudflare telemetry for the first
project records successful birth/readiness followed by `durableObjectReset`
warnings on its stream sink at `00:05:00Z` and `00:05:04Z`. Its creation began
before the 90-second clock expired, because only Vitest consumed that boundary.

The follow-up keeps the Playwright process parallel but passes the absolute
rollout deadline into its project helpers. Forged-session creation and the real
email-signup form wait only immediately before creating a project; Chromium,
page setup, authentication, browser-only specs, smoke, TUI, and other app suites
continue to overlap the rollout. The rejected 4/25 streak remains diagnostic
evidence only; the accepted counter restarts at 0/25 on the new head.

PR #2265's first formal head, `e5e9990986834b9c3c340e746b626ba0974e96bb`,
then passed one complete run in 285 seconds with zero retries. The next run was
rejected at 372 seconds after three permitted test retries exposed two distinct
defects:

- Semaphore and Streams addressed old Durable Object versions after their new
  edge Workers were ready. Semaphore traces contained both the prior and new
  code versions; Streams reported an explicit code-update reset. The 90-second
  gate had covered only OS, so the fix applies the same
  per-deployment boundary to every live suite that calls Durable Objects. The
  short app commands wait at their own boundaries while all app lanes remain
  concurrent; OS still overlaps browser/auth setup internally.
- Playwright's empty-agent-feed case timed out while creating project
  `prj_ddc2a50bba2941878bed307b207417ea`. Trace
  `eb26b8dc5ae96c5da9373abef6e8606d` shows `Project.create` alive until the
  90-second caller watchdog canceled it. The durable event history is
  conclusive: config-repo creation began, Cloudflare Artifacts returned
  `INTERNAL_ERROR` after 32.7 seconds, and the repo processor journaled
  `repos/create-failed`. No `repos/created` or `project/ready` fact followed,
  even after later wakes. The Playwright retry created a different project and
  passed, masking the permanently poisoned first project.

`INTERNAL_ERROR` and `UPSTREAM_UNAVAILABLE` are Artifacts service-availability
outcomes, not invalid repo requests. Repo creation now leaves its existing
idempotent durable obligation open for redelivery on those two codes, exactly
as it already does for a Durable Object lifecycle reset or an Artifact that is
still materializing. Input/domain errors still append terminal
`repos/create-failed` and remain fail-closed. Focused processor tests prove both
classifications and the failed-attempt → redelivery → one `repos/created`
recovery path. These fixes change the immutable head, so neither formal run is
counted and the accepted streak restarts at 0/25.

## Round 9 (2026-07-22, post-#2260)

This proof starts from `origin/main` at
`7ad6d92037663ac2aba0d0b15ba9550c2a0f685b`, after deploy-phase telemetry
(#2254), the zero-budget worker-build cache race fix (#2256), sandbox RPC
settlement lifetime hardening (#2257), and the bundled REPL TypeScript runtime
(#2260). PR #2261 carries the immutable proof head. The accepted counter starts
at zero.

Round-9 run ledger:

| Proof              | Revision                                   | Accepted runs | Retries | Outcome                                 |
| ------------------ | ------------------------------------------ | ------------: | ------: | --------------------------------------- |
| Round-9 marathon 1 | `6a7e1d0956e0fc64c8913167318442752df975ba` |          0/25 |       4 | Functional pass; rejected at 363s       |
| Round-9 marathon 2 | `6a7e1d0956e0fc64c8913167318442752df975ba` |          0/25 |       0 | Clean functional pass; rejected at 350s |
| Round-9 marathon 3 | `64bc519b4d68d3d8fad6c4337d0ad8a137aa2332` |          0/25 |       9 | Failed OS Vitest during rollout at 270s |

The first attempt was [Depot run
`nfwh10j558`](https://depot.dev/orgs/0p91s0lz49/workflows/jc0n8v979h?job=fvhg7qc9bn&attempt=v96gml6mn4).
All apps eventually passed, but four unrelated cases retried: agent delegation
lost its CapabilityHost incarnation, direct MCP lost its connection, a project
stream subscription exhausted its 120-second outer watchdog, and the browser
half-open test did not paint an already-durable assistant event before its
30-second UI wait. Running each exact case five more times against the unchanged
warm deployment produced 20/20 first-attempt passes. That control does not count
toward the streak; it localizes the shared cluster to the fresh-deployment
window rather than four deterministic victim-test defects.

The second attempt was [Depot run
`bj3zqplkn6`](https://depot.dev/orgs/0p91s0lz49/workflows/jc0n8v979h?job=fvhg7qc9bn&attempt=whs8hfhl30).
Every test passed on its first attempt, but the strict loop rejected the
350-second wall time. The normalized phase evidence accounts for the whole
critical path: roughly 40 seconds of pickup/setup, 158 seconds to the global
deployment barrier, 143 seconds of tests, and 7 seconds of finalization. OS
readiness alone took 72.3 seconds; streams readiness took 136.6 seconds. During
those waits the active probes received Cloudflare 1101/HTTP 500 responses and
later 503 `probe-timeout` responses even after all ten waves had previously
reported ready.

The readiness implementation was stale relative to the contract already
documented in `ci-preview-performance.md`. OS created 25 synthetic Durable
Object identities per wave across ten waves, then slept ten seconds and checked
the complete set again: up to 500 Durable Object RPCs per deploy. Streams did
the same with eight identities per wave: up to 160 more RPCs. Besides dominating
the deploy tail, this finite placement sample cannot prove the rest of the fleet
and did not prevent attempt 1's real project identities from encountering
lifecycle transitions.

PostHog confirms this was a fleet-wide tail rather than one bad runner. Across
the preceding 24 hours, 30 OS deploy lanes spent a median 61.3 seconds in
readiness (p90 93.9 seconds; max 118.8 seconds), while 22 streams deploy lanes
spent a median 56.0 seconds (p90 93.5 seconds; max 136.6 seconds).

PR #2261 therefore removes the synthetic Durable Object gate, its authenticated
probe protocol, and its orchestration/test machinery. Readiness is once again a
cheap public request that must report wrangler's exact `CF_VERSION_METADATA`
version; the first exact match releases the test barrier with no artificial
dwell. Product operations remain responsible for explicit Durable Object
lifecycle outcomes, as the existing performance contract requires. This change
resets the accepted streak to 0/25; only a canonical Depot run on its new
immutable head can restart it.

The first canonical run after removing the probes, [Depot run
`69ccf2rkj7`](https://depot.dev/orgs/0p91s0lz49/workflows/jj6p9xkh2z?job=tqpx1h1kwr&attempt=5cj8k7kk2d),
made the remaining boundary precise. All five deploys passed and every non-OS
suite passed. OS Playwright passed 63/63 and the onboarding smoke completed on
its first attempt in 26 seconds, but nine OS Vitest cases entered retry; eight
recovered and the preview-smoke case failed both attempts. Every affected test
was scheduled within the first second of Vitest. The errors were rollout-wide
(`Durable Object reset because its code was updated`, failed WebSocket
connections, and internal references), while files scheduled later had no
retry. This is a fresh-deployment fan-out race, not nine independent test
defects.

The minimal boundary is now the existing production-shaped onboarding smoke,
not a synthetic fleet sampler. Chromium installation, the smoke, and TUI start
immediately; Playwright starts as soon as Chromium is ready; high-fanout Vitest
starts only after the smoke has successfully created a real project and served
its project/agent/stream flow. The 26-second propagation window remains hidden
under the 139-second Playwright critical path, adds no arbitrary sleep or retry,
and fails fast if the real canary cannot complete.

## Round 8 (2026-07-22, post-#2251)

This is a fresh proof from `origin/main` at
`cd5f4a67b9df5bc05fd2e38fe5ea9eda63bd6e7b`, including the cold worker-build
handoff from #2251 and the fixed durable-stream telemetry from #2249. It
inherits no streak: the accepted-run counter starts at zero.

The final #2251 head, `a0380f8d078ddab6a825f9a070b2a8f433d5e7e4`,
passed its normal preview check on the first workflow attempt. The complete
check took 5m20s. OS deployment was the critical deployment lane at 148.9s,
while OS e2e took 133.7s: Playwright passed 63/63 tests in 2.1m and Vitest
passed 48 files, with 2 skipped, in 78.98s. This is useful green baseline
evidence but not an accepted marathon run because it exceeded five minutes
and absorbed one Vitest retry.

The retried case was `Project worker processEventBatch receives events from
every project stream and can cross-post`. Its first attempt reached the
30-second stream-wait watchdog and its retry passed, bringing the case to
59.18s. This first occurrence is recorded rather than quarantining a
substantial concurrency test from one observation. Any recurrence in this
round rejects the run and triggers diagnosis; a test shown to be independently
flaky or pathologically slow will be fixed or quarantined with a tracking task
under the normal testing policy.

Round-8 run ledger:

| Proof                    | Revision                                   | Accepted runs | Retries | Outcome                                     |
| ------------------------ | ------------------------------------------ | ------------: | ------: | ------------------------------------------- |
| Pre-round normal preview | `a0380f8d078ddab6a825f9a070b2a8f433d5e7e4` |          0/25 |       1 | Passed in 5m20s; cross-project stream retry |
| Round-8 marathon 1       | `e301520145a6259a743a3e300366a0a53689a009` |          0/25 |       2 | Functional pass; rejected at 311s           |
| Round-8 marathon 2       | `c2a695fac7279da1b3b9bb64512a2d08d20aa576` |          0/25 |       0 | Clean pass; rejected at 311s                |
| Round-8 marathon 3       | `723f73067c13fa52512593f9e2952ffc91618ef2` |          0/25 |      19 | Shared-isolate cancellation; rejected       |

The first round-8 attempt was [Depot run
`3jp43c0dbg`](https://depot.dev/orgs/0p91s0lz49/workflows/vxd3v2n769?job=xjm4379s33&attempt=lp5zq2dfp4).
Every test eventually passed, but the proof stopped because the workflow took
311 seconds and absorbed two retries. OS deployed in 101.7 seconds and its e2e
lane took 152.6 seconds. Vitest passed 48 files, with 2 skipped, in 86.15
seconds; Playwright passed 63 cases in 146 seconds.

The project-worker cross-post case again exhausted its 30-second stream wait
before passing on retry, reaching 62.79 seconds across both attempts. This
second consecutive occurrence establishes a cold-build delivery tail rather
than a one-off test failure. The test still exercises a fresh worker build and
is not quarantined; its public delivery budget is temporarily 100 seconds, and
`tasks/reduce-project-worker-cross-post-tail.md` tracks instrumentation,
latency reduction, and restoration of the tighter budget.

The other retry was the markdown-preview Playwright spec. The network trace
showed the parent project route's identity `beforeLoad` taking 1.79 seconds
after the Preview search-param navigation. The test selected Code while that
first transition was still settling; `.cm-content` remained absent for roughly
1.3 seconds, then the editor was fully rendered in the failure screenshot
about 100 milliseconds after the action deadline. The IDE now renders a
visible, `data-spinner`-marked status while TanStack Router is loading. This
exposes the real product wait and lets the normal spinner-aware action deadline
cover it; the substantial markdown editing and sanitization spec remains
active.

This head therefore contributes zero accepted runs. The next immutable head
starts a new 0/25 streak through the same canonical Depot workflow.

The next canonical attempt on that head was [Depot run
`w9sc1f40ds`](https://depot.dev/orgs/0p91s0lz49/workflows/s5sm8wx775?job=xl2nzs4w1s&attempt=jf9f0zg4z2).
It was the first complete zero-retry pass in this round: all 48 runnable OS
Vitest files and all 63 Playwright cases passed on their first attempt. OS
deployed in 116.2 seconds and its e2e lane passed in 146.9 seconds (Vitest
113.08 seconds; Playwright 2.3 minutes). The strict proof still rejected it
because dispatch creation through completion took 311 seconds.

Reporting accounted for the avoidable final tail: normalization produced
6,865 PostHog events, then the uploader sent 69 fixed 100-event batches
strictly sequentially, consuming 12.9 seconds before artifact collection.
The uploader now packs events by encoded size, with a conservative 5 MB event
payload budget beneath PostHog's 20 MB batch-request limit. The preceding
5,906-event artifact packs into three requests instead of 60 while preserving
every deterministic event UUID and the existing per-batch bounded retry. The
next canonical run, [Depot run
`h95t4wvm5n`](https://depot.dev/orgs/0p91s0lz49/workflows/vsm4b78r2d?job=gtxq2vksbg&attempt=ppp78dt78z),
confirmed the real upload tail fell by roughly 10 seconds. The complete check
still took 312 seconds and absorbed 19 Vitest retries, all from one synchronized
`Peer closed WebSocket: 1006` wave; every retry passed.

Cloudflare traces identified one causal test rather than 19 independent
flakes. The live-capability WebSocket boundary probe caught its expected
serialization error and reported a pass, then the runtime canceled that
session's root `GET /api` because the Worker had hung and would never generate
a response. Three isolated apparent passes reproduced the hidden runtime
cancellation three times out of three. Because every Vitest file correctly
runs in parallel against the same OS deployment, that isolate cancellation
severed unrelated sessions across otherwise-independent projects.

Both cases in `live-capability-websocket.e2e.test.ts` are explicitly
quarantined under
`tasks/quarantined-live-capability-websocket-e2e.md`. The causal boundary case
is deterministically runtime-fatal; the second was a `test.fails` that stopped
on an unrelated stale-template assertion and therefore provided no active
coverage. Ordinary live capabilities, project-app WebSockets, and all other OS
Vitest files remain enabled. This quarantine resets the immutable head and the
accepted streak to 0/25; only a canonical Depot run can restart it.

## Round 7 (2026-07-21, post-#2226 and #2227)

This is a fresh proof from `origin/main` at
`767baafc35c774f48916a15278659e61dd8c9670`, after unified CI/test telemetry
(#2226) and immediate OS Vitest file scheduling (#2227) merged. It inherits no
streak: the accepted-run counter starts at zero.

The exact #2227 head, `220ab10c9fd2ea51d4cd15ac4a0659fdf7562ed1`,
passed its normal preview check on the first workflow attempt. The complete
GitHub check took 4m59s, including pickup, setup, deployment, tests, and final
bookkeeping. OS deployed in 115.5s and its e2e lane passed in 158.9s. Within
that lane, all 48 runnable Vitest files were scheduled immediately and Vitest
finished in 78.28s, down from 181.77s with the former seven-worker queue.

One matrix case, `run-script`, passed on its permitted single Vitest retry
after the separate Node runtime reported `WebSocket connection failed.` The
run stayed green, but the retry is part of this round's evidence and will be
compared with subsequent telemetry before any harness change. No extra retry
layer or test-specific exception has been added.

Round-7 run ledger:

| Proof                        | Revision                                   | Accepted runs | Retries | Outcome                                        |
| ---------------------------- | ------------------------------------------ | ------------: | ------: | ---------------------------------------------- |
| Pre-round normal preview     | `220ab10c9fd2ea51d4cd15ac4a0659fdf7562ed1` |             1 |       1 | Passed in 4m59s; Node transport-open retry     |
| Round-7 marathon 1           | `210f7ef88d6d8170daaf893380bd54f0da0cb8c2` |          0/25 |       1 | Functional pass; rejected at 318s              |
| Round-7 exact-head preview 1 | `210f7ef88d6d8170daaf893380bd54f0da0cb8c2` |             1 |       1 | Passed in 4m34s; example-app event-count retry |

The first round-7 marathon was [Depot run
`glfbndtvnx`](https://depot.dev/orgs/0p91s0lz49/workflows/glfbndtvnx).
Every test passed, but the proof correctly stopped because deploy plus tests
took 318 seconds. OS was the critical app: deployment took 127.6 seconds and
tests took 162.2 seconds. Playwright dominated the test lane at 155 seconds;
Vitest took 77 seconds. The eight Playwright workers each performed between
133.6 and 150.0 seconds of work, so the queue was already balanced: merely
reordering files cannot materially shorten this lane. Depot's 16-core runner
also peaked at only 41.7% CPU and 15.0% memory, which does not support a larger
runner as the first optimization.

One Vitest case, `MCP built-in connects directly and mounts as a described
capability`, passed on retry after Cloudflare reported `Durable Object storage
operation exceeded timeout which caused object to be reset.` The same Durable
Object startup-reset class occurred on unrelated PRs #2224 and #2231, so this
is classified as a shared Cloudflare transient rather than a defect in the
victim test. Its one repository-level retry remains bounded and visible.

The unchanged head then passed its normal preview check on [Depot run
`r62fmqfqp5`](https://depot.dev/orgs/0p91s0lz49/workflows/r62fmqfqp5) in
4m34s. OS deployed in 94.6 seconds and its tests took 154.6 seconds, confirming
that rollout/readiness variance accounted for most of the rejected marathon's
33-second overrun. The streams example app absorbed one Playwright retry after
its scroll-away counter expected 83 events but observed 84; the retry passed.
This first occurrence is recorded rather than quarantined. Recurrence will be
fixed or quarantined with a tracking task under the normal testing policy.

## Round 6 (2026-07-21, post-#2169)

This is a fresh proof from `origin/main` at
`a999a11a00987bd59694d79f20949353644f29f6`, after PR #2169 merged. It does not
inherit a streak from that PR: the counter begins at zero and the complete
deploy-plus-test critical path is run 25 more times.

The exact final tested head before #2169's squash merge was
`950a4f01726f52ec2fb185305dc4dcf9baa7745d`. Its normal preview check passed.
Schema-v2 PostHog telemetry recorded a 187,448ms test operation, 306 logical
test results, 95 Playwright attempt results, 208 named test phases, and 57
module results. It also exposed one absorbed Vitest retry:

- lane: OS Vitest
- module: `apps/os/e2e/examples/examples-matrix.e2e.test.ts`
- test: `catalogue example "repo-read-file" runs identically across runtimes`
- first failure: the spawned CLI runtime lost its initial Cap'n Web connection
  with `WebSocket connection failed.`
- retry: the complete matrix case passed in 30,008ms

The failure is not evidence against `repo-read-file`: the other runtimes
completed and the retry passed. It is a transport-open failure in the genuinely
separate CLI process. The CLI currently makes one connection attempt and the
single Vitest retry reruns the whole isolated case, which is the repository's
intended one retry layer. No nested transport or harness retry has been added.
The CI diagnostic already included the enriched
`cli process failed — stderr:` output; Node's `execFile` defaults to UTF-8
strings, so PR #2169's Buffer-output bot comment does not describe the observed
runtime and needs no speculative conversion.

An absorbed retry remains a green run under the testing policy, but it is never
silent: every retry in this round is classified from telemetry plus CI logs and
artifacts. Any reproducible product or harness defect gets a minimal fix on its
own reviewed green PR before the streak resumes. The catalogue runtime matrix
remains intact.

Round-6 run ledger (filled from the marathon's machine-readable summary):

| Proof                    | Revision                                   | Accepted runs | Retries | Outcome                                           |
| ------------------------ | ------------------------------------------ | ------------: | ------: | ------------------------------------------------- |
| Pre-round normal preview | `950a4f01726f52ec2fb185305dc4dcf9baa7745d` |             1 |       1 | Passed; CLI transport-open retry classified above |
| Round-6 marathon 1       | `443d7a49a6da759842248ce8b284c820db2a41ab` |          0/25 |       0 | Functional pass; rejected at 312s                 |

The first round-6 marathon was [Depot run
`2b0d59sw92`](https://depot.dev/orgs/0p91s0lz49/workflows/2b0d59sw92).
Every test passed without retry, but the proof correctly stopped because the
deploy-plus-test critical path took 312 seconds: 123.9 seconds deploying, then
188.4 seconds testing. OS Vitest was the test pole at 181.8 seconds.

Schema-v2 module timing showed why. The seven-worker cap made the final
33.7-second `itx-egress.e2e.test.ts` file wait 147.6 seconds before it could
start. The 48 OS module executions contained 1,112.7 seconds of remote work;
even perfect seven-worker scheduling has a 159.0-second lower bound. These
files create isolated projects and spend nearly all their time awaiting remote
operations, so CI now gives every file a worker immediately. The in-file limit
of two remains for the few cases that deliberately share a bounded project
pool. The next marathon measures whether the deployed platform has a real
capacity limit instead of encoding an assumed one in the local scheduler.

## Round 5 (2026-07-21)

This round starts from current main. Its baseline is PR #2140's exact tested
head `2d156e0c3`: the complete preview job passed in 4m05s with zero test
retries. Deploys already start together, app e2e lanes start together, and OS
starts smoke, TUI, Vitest, and Playwright together. The remaining proof is
distributional: 25 consecutive full deploy-and-test runs, each under five
minutes, with every absorbed retry visible in the ledger and investigated.

Progress and failure diagnoses live in the active PR's comments; this section
is updated with the final run IDs and outcome once the proof completes.

The first exact-head normal preview after the TUI fix was green but took 5m01s.
Its OS Vitest lane was the critical path at 187s: the suite still capped 48
isolated files at seven workers, and a stale 8s scheduling estimate started the
`admin-project` file late when it actually took 83s. The cap and estimated-time
sequencer are now gone. CI gives every file a worker immediately on a 64-core
runner, so the intended bound is the slowest individual file (plus its one
allowed retry), not several scheduling waves.

The first marathon attempt (`wzg4nbj1j7`) stopped on run 1 after both TUI
workflows hit their 45s watchdog. TUI Test 0.0.4 then reported an immediate
`Worker terminated` for each retry and wrote no trace. Source inspection found
two deterministic test-harness defects. The dynamic agent-path suffix made the
header long enough to clip the literal `live` label while the terminal was in
fact connected and fully rendered, so both tests waited on absent layout text.
Then the framework timeout terminated the per-file worker, but its retry loop
reused that same dead worker; trace persistence also runs inside the worker
after the test returns. The agent path is now a short constant within each
fresh project. The TUI lane launches its two independent workflows concurrently
in separate processes/projects, retries only the failed workflow at the wrapper
boundary with a new process/project, and uses assertion deadlines below the 55s
hard watchdog so ordinary failures persist terminal diagnostics and
per-attempt traces before process teardown. A direct preview-7 proof completed
both workflows on their first attempt in 8.6s max (19s including the one-time
package build and project setup).

Update (2026-07-21): the TUI lane was subsequently **skipped entirely** rather
than hardened further. A cleanup pass found the isolation harness still
fighting more tui-test 0.0.4 shared-global defects (the cwd transform cache
and the tmpdir zsh dotfiles folder both race across concurrent invocations),
and the TUI has known bugs and no users yet — so `e2e/tui-test/run.ts` is now
a no-op stub that reports an empty retry ledger, and the specs stay on disk
for a future revival. See the stub's header and
`apps/os/e2e/tui-test/README.md`.

## Round 4 (2026-07-13/14, PR #1938)

Goal: 25 consecutive green runs on Depot, re-validating the lane after a week
of heavy merging (subagents/unified messaging, stream metrics,
MCP OAuth, sandbox AI-gateway egress, …). The then-current method used the
since-retired nested `preview-e2e-marathon.yml` workflow against this PR's
leased slot, failing fast and fixing every root cause before resuming.

Result: **96 consecutive green runs in one night, zero test failures, zero
flakes found** — the goal met on the first marathon and re-proven three more
times across six merged main heads. Detailed per-run log in the PR comments.

- **marathon r4-1** `r59ccf138r` (head = main 0d53cbc7e): **25/25 green**,
  21:51–22:53 UTC, ~2.2–2.9 min/run.
- **marathon r4-2** `dgnsqq9jng` (merged main 9b9f3404d): **21 clean**, then
  run 22 stopped in 4s — not a flake: the slot's semaphore lease had been
  claimed by `main-auth-rpc-security-cutover` (the #1940 validation), whose
  deploy replaced the PR's apps on preview-3. The ownership guard in
  `preview test` fired exactly as designed. The marathon claimed a fresh slot
  (preview-1) and moved on.
- **marathon r4-3** `4xg33k0bf5` (merged main ce18a7d79): **25/25 green**,
  01:09–02:17 UTC. Runs 24–25 slowed to ~6 min (os lane 372s/355s) with
  recovered onboarding-stream `liveness probe` WebSocket reconnects — the
  flake-23 pool-saturation tail signature (the pool rides at the per-type
  `SANDBOX_MAX_INSTANCES` preview cap; #1747 replaced the flat cap-150 with
  that table), fully absorbed by the
  reconnect/retry machinery. The next marathon's preflight redeploy flushed
  the pool and restored ~2.2 min/run pace from run 1, confirming the
  mechanism (a rollout resets assigned instances).
- **marathon r4-4** `6q6j7wlz3z` (merged main d36c2f38d): **25/25 green**,
  02:24–03:24 UTC, no tail slowdown.

Cost (measured; full breakdown in the PR): ~$54 for 101 lane executions ≈
$0.53/run — 92% LLM tokens (gpt-5.6-sol BYOK, $49.36 uncached), with the
AIG response cache absorbing 46.4% of requests (~$42 saved); Depot 8-core
compute ~275 min ≈ $4.40.

Round-4 lessons (no test-failure fixes needed; the PR carries only the
slot re-claim above plus a dead-code/doc-drift sweep from the round's
follow-up reviews):

- The round-1..3 fixes have held through a week of heavy platform churn; the
  lane's stability is structural, not a lucky streak.
- A marathon can lose its slot mid-flight to a legitimate external claim;
  the guard converts that into a clean fast stop. The loop now re-claims a
  slot (full-fleet redeploy) and re-runs the interrupted run number uncounted,
  capped at `MAX_SLOT_RECLAIMS` (2) per marathon — no tests ran under the
  refusal, so this is environment re-establishment, not a retry layer.
- Sandbox-pool tail pressure at the per-type preview caps is visible (slower
  runs, recovered liveness reconnects) after ~25 runs on one deploy but
  self-heals on redeploy and never failed a run; watch it if marathons grow
  past ~30 runs per deploy.

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
  to 150 after Cloudflare rejected 500 against the preview account memory quota.
- **marathon6** `gb1g4sg7rs`: 25 clean at a steady ~60-90s/run — cap 500
  eliminated the saturation slowdown entirely (pool rode at `assigned: 491`
  with NO latency growth, where cap-100 marathons were at 3-5min/run by run
  20). Run 26 failed on the lane's one retry-less gate: `onboarding-smoke.ts`
  — the onboarding agent didn't greet within 90s ("saw 0 events") and the
  remote timeout crashed the bare tsx process. Fix: the smoke now makes 3
  attempts, each with a fresh session + project, matching the vitest lane's
  `retry: 2` policy; a broken slot still fails all three inside ~5min.
- **2026-07-07 quota correction**: the preview cap was reduced 500 → 150.
  Cap 500 helped a single marathon slot, but multiple preview slots at
  `standard-1` exceeded the dev/preview account memory quota and blocked new
  deploys. Cap 200 fits a partially populated preview fleet, but not all nine
  preview slots once each carries the OS sandbox app. Cap 100 previously
  wedged at `assigned == max_instances`; 150 is the fleet-wide compromise
  until Cloudflare changes assigned-slot accounting.
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

**2026-07-17, explicit-births follow-up:** requiring a mutation clone to see
the exact advertised head closed the replica-lag case, but a retries-disabled
preview run exposed a distinct writer. The failed repo stream had no user
commit fact, while its Artifact history contained two consecutive
`Seed minimal itx project worker` commits. An at-head creation obligation had
been driven twice; the old seed path always made and force-pushed a commit even
after cloning an existing branch, so it moved `main` between the mutation's
checked clone and push.

The creation call now shares the Repo DO's write serializer with mutations.
Seeding is strictly create-if-absent: cloning any existing branch returns it
untouched, including user commits. Two genuine first drives that both observe
an empty Artifact produce the same root oid from a fixed synthetic seed
identity and timestamp, making their pushes equivalent. Initial publication is
also a normal fast-forward push, never forced: if a different head wins the
race, creation fails instead of replacing it.

The same retries-disabled run found an independent first-use secret race. A
GitHub App token mint read secret state at offset 5; a
`subscriber-connected` telemetry fact advanced the raw stream to offset 6;
the material append's explicit offset then conflicted and was incorrectly
reported as `secret_not_found`. Refreshed material now retries bounded offset
conflicts while the reduced secret's `updatedOffset` and refresh policy remain
unchanged. Any actual secret update still invalidates the in-flight mint.

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
  regardless of which head recorded them. (`awaiting-tests` initially kept a
  same-head guard; it too retries at any head since the `preview run`
  one-step refactor — an awaiting-tests entry at any head is a deploy whose
  e2e never ran.)

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
  Historical fix: the then-current in-process loop walked the whole descendant
  tree and `SIGKILL`ed it leaf-first. That `kill_tree` implementation was
  retired when the marathon became an observer of canonical Depot runs.
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
— the two failure modes above are structurally impossible. Repo seeding now
uses the same non-forced publication rule.
The diagnosis is retained here because it explains _why_ main dropped `force` and
serialized writes; the marathon re-verifies it end-to-end.

**2026-07-17 correction:** serialization prevents two calls in one Repo DO
from overlapping, but it does not make the Artifacts clone endpoint strongly
consistent. A second serialized write can clone a replica that still advertises
the pre-first-write head and then lose the server's ref compare-and-swap with
`stale ref`. Mutations now record the seed and every successful push, and wait
boundedly until their clone's branch HEAD equals that last pushed commit before
changing anything. Merely finding the commit object in the clone is not enough:
Artifacts can supply the object while its advertised ref still lags. A later
rejection therefore really does identify an out-of-band writer that moved the
ref after the checked clone.

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

Historical fix in the then-current loop: a fresh marathon ran a full-fleet
deploy preflight before counting. The current orchestrator instead dispatches
the canonical workflow, whose manual-dispatch path passes `--all-apps`; every
counted Depot run therefore deploys and tests the complete fleet directly.

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
cleanup reliable at any cap. That round also briefly added uncounted warmups;
they were later removed because cold-start behaviour is part of the production
path and every proof run must count.

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
the pool. On 2026-07-07 this was reduced to **150** because several preview
slots at 500 `standard-1` instances exceeded the dev/preview account memory
quota and blocked deploys; 200 fit the currently populated fleet but did not
leave room for all nine preview slots to carry OS sandbox apps. Destroy
remains correct — it is what lets an idle fleet drain back to zero instead of
holding slots forever. If sustained-churn claim latency reproduces at the
cap, this becomes a Cloudflare Containers escalation (pool-manager
degradation under DO-binding churn), not an app-side fix. (Update 2026-07-08:
#1747 replaced the flat cap with per-instance-type caps —
`SANDBOX_MAX_INSTANCES` in `apps/os/scripts/generate-wrangler-config.ts` is
now the source of truth; the saturation mechanics above are unchanged, per DO
class.)

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

### 23. spinner-to-content handoff can false-fail with a 1ms timeout

**Signature:** `dashboard.spec.ts` reports `Timeout 1ms exceeded` waiting for
the project link, while the failure screenshot and accessibility snapshot
already contain that exact visible link. The page showed its route/query
"Loading projects..." indicator continuously until the table replaced it.

**Root cause:** middlewright first polls target readiness, then separately
checks whether any spinner is visible. React can atomically commit the
spinner-to-content replacement between those browser reads: the target was
absent at the last poll, then the spinner was absent at its check. The waiter
therefore took its no-spinner fast-fail path and gave the now-appearing target
only 1ms. This is a test-waiter TOCTOU race, not missing product progress UI.

**Fix:** `patches/middlewright@0.1.2.patch` gives the target one 100ms polling
interval after observing no spinner. A genuine no-spinner failure still fails
in about a second; an atomic loading-to-ready handoff can complete without a
false failure.

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

### Push-lane deployment-version barrier

- **Guarded: deploy→test race: `Durable Object reset because its code was
updated`.** `wrangler deploy` can return while Cloudflare is still propagating
  the new code. This produced a rollout-wide failure on commit `1796831c`: the
  onboarding smoke reset on its first attempt, 30 Vitest tests retried, and 19
  still failed. A retry was not a sufficient boundary. OS `/api/health` now
  reports its `CF_VERSION_METADATA` id, and the preview orchestrator parses the
  final `Current Version ID` from the deploy (the main Worker follows its two
  sidecars) and requires that exact version on the health probe before the test
  phase can create a project (first match; no multi-second dwell). A plain 2xx
  no longer counts as post-deploy readiness. The next fully settled run then
  exposed a separate deterministic problem: E2E fixtures still relying on implicit
  processor births. Those fixtures now create their agents, repos, secrets,
  and integration routers explicitly.

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
