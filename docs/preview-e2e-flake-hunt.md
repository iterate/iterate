# Preview e2e flake hunt

> This document is the evidence log — every flake, root cause, and marathon
> run. The **policy** distilled from it (one retry layer, watchdog sizing,
> retry telemetry) lives in [testing.md → Retries and
> timeouts](testing.md#retries-and-timeouts).

Current goal: run the complete preview pipeline against a real preview
environment 25 times in a row without a single failure, with every full-fleet
deploy plus e2e run completing in under seven minutes and without an absorbed
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
head, absorbed retry, or run at or above seven minutes, and writes a
machine-readable ledger containing the immutable head plus Depot run/attempt
IDs, whole-run duration, and retry count. It reads retry counts from the
always-retained canonical telemetry artifact as well as the successful-run log
annotation, because a failing test command can prevent the annotation from
being emitted even though the finalizer retained the raw runner evidence.
Every failure, retry, or tail gets a root-cause diagnosis and the smallest
reliable fix; any of them resets the consecutive-clean counter.

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

## Round 16 (2026-07-28, rollout recovery)

This round starts from merged `origin/main` at
`02c089ec2e8c3fbcd69a1211c4b92dc7030b56ef`. A deduplicated PostHog review of
the preceding three days found 36,900 completed test executions with zero hard
failures and one absorbed retry. The ten most recent executed preview runs were
all finally green, but only seven were strict zero-retry/error runs and the
current strict streak was two. Over seven days, preview end-to-end duration was
259.8 seconds at p50 and 373.5 seconds at p95; the latest complete sample took
4 minutes 39 seconds.

The leading deterministic cost was the synthetic rollout gate, not useful
work: the latest run's 15 Playwright `create project fixture` phases each spent
83–86 seconds behind the same 90-second deployment-age clock. Round 15 had
already observed an exact-version Durable Object reset about 140 seconds after
deployment, proving that the clock was neither a sufficient convergence
barrier nor a targeted recovery mechanism.

This round therefore deletes the gate and its test/fixture plumbing. A
read-only `waitForEvent` with a stable durable cursor now replays one classified
deploy/eviction reset on a fresh stub; an explicit public `kill()`, a second
reset, and every predicate/application failure remain terminal. Raw overload is
explicitly non-retryable even if workerd also sets `retryable`, so recovery
cannot amplify a saturated object. Preview retry annotations also distinguish
passed-after-retry from still-failed records instead of claiming every retry
passed.

The draft PR's first two preview checks correctly left the proof at 0/25. The
first caught that the initial replay boundary also swallowed the explicit
public stream `kill()` test; the retry predicate now keeps that deliberate
lifecycle error observable while still replaying deploy/eviction resets. The
second passed in 3 minutes 31 seconds but absorbed a Playwright retry in the
seeded Guestbook after its signing RPC took longer than the test's silent-UI
budget.

That retry was not isolated noise. A UUID-deduplicated 14-day PostHog query
found 265 Guestbook browser executions, nine that retried or still failed
after retry, and seven with the same `Timeout 1ms exceeded` signature while
waiting for the newly signed note. The form disabled its submit button while
the RPC was pending but exposed no progress state, so middlewright correctly
refused to hide the delay behind a long wait. The packaged Guestbook now
renders an accessible `Signing…` status with `data-spinner="true"` for the
whole action, matching the sibling Todo app's mutation-progress contract.

An exact-head preflight on `ed86898b6` then passed with zero framework retries:
Depot run `d1d3gtdx21` finished in 4 minutes 55 seconds from creation (GitHub's
check interval was 4 minutes 32 seconds), all expected telemetry sources
finalized, and both Guestbook and Todo passed first try.

The first strict iteration correctly rejected another finally-green run
(`dd57pvnv7c`, 3 minutes 24 seconds) because it absorbed two Vitest retries.
A UUID-deduplicated 30-day PostHog query showed that neither retry was unique
to that run: the nested live-capability test had retried twice in 306 Depot
executions, while the 20-script concurrency test had retried eight times in
306 Depot executions. Both always passed after retry, which made them easy to
miss in final-status-only CI reviews.

Cloudflare traces and the durable script journal tied both retries to the same
rollout boundary. A keyed project-root append was rejected on the previous
Worker version 49 seconds after the new deployment completed; root appends
were excluded from the silent-ack deadline but accidentally excluded from
classified lifecycle replay too. Keyed root appends now retain the intentional
no-deadline rule while replaying one deploy/eviction reset. Unkeyed appends,
explicit `kill()`, application errors, and a second reset remain terminal.

The concurrency failure was importantly different: 19 scripts completed, but
one durable settlement recorded `executionMayHaveOccurred: true` after its
CapabilityHost incarnation was reset for a code update. Re-running arbitrary
code could duplicate external effects, so `runScript` still never does that.
Instead it now performs a bounded read-only exact-version handshake with its
CapabilityHost before journaling the request. A stale incarnation may converge
or survive one lifecycle reset; persistent mismatch, probe failure, or a
second reset fails explicitly while the durable history still proves that the
script was never requested and never ran. The concurrency assertion also
prints every rejected script index and reason instead of a generic object
diff.

The corrected `935ca2e93` head then passed its exact-head preflight with zero
retries: Depot run `0znz7824db` finished in 2 minutes 40 seconds and the
finalizer normalized all ten telemetry artifacts into 6,744 PostHog events.
The first strict iteration (`6f6c34k211`) was finally green in 3 minutes 41
seconds, but correctly reset the proof to 0/25 because the live-state Vitest
case absorbed a retry. Its first attempt spent 99.3 seconds waiting for a new
project to become ready; the fresh-project retry passed in 16 seconds.

PostHog established the tail rather than treating it as an isolated slow run.
Across 313 executions of that exact test in 90 days, all on Depot, two had
retried. Normal duration was 11.8 seconds at p50, 18.7 seconds at p95, and 29.1
seconds at p99; the longest zero-retry success was 47.5 seconds, while this
retry reached 115.3 seconds. A separate July 22 test retry had surfaced the
same generic `Default project worker did not become ready before
project/ready` failure.

Cloudflare traces showed that project birth and the config-repo seed completed,
the exact default-worker build artifact was already cached, and an isolated
project created immediately afterwards became ready and served successfully.
Under the failed full-suite burst, however, the root processor repeatedly ran
the same roughly six-second readiness loop. That loop used an application HTTP
`fetch`, blindly retried every error 20 times, then threw one generic outer
error whose cause was lost across the Durable Object boundary. It therefore
could neither classify the failing condition nor distinguish platform
readiness from the seeded app's HTTP behavior.

Project birth now calls a platform-owned primitive handshake inherited from
`IterateWorkerEntrypoint`. It retries only the named repo-not-seeded,
worker-build-in-progress, and Durable Object availability states, polls every
500ms under one 60-second deadline (above the observed zero-retry success
tail), clamps each cold-build wait to at most five seconds and the remaining
deadline, and reports aggregate outcome counts on convergence. The SDK owns
the reserved acknowledgement instead of dispatching it into application code.
An application error or invalid acknowledgement fails on the first attempt
with its name/message embedded in the outer error; deadline exhaustion records
the attempt count, every transient class, and the last error. This removes
both the Response-stub/application coupling and the unobservable blanket
retry.

The exact-head preflight for that fix (`d4ddeab588`, Depot run `5b8nq1b3qs`,
attempt `v6mtqjfkdw`) was rejected after 2 minutes 44 seconds with two Vitest
retries. All ten artifacts still finalized normally into 6,853 PostHog events.
The ephemeral-events catalogue test passed after one retry; the two-client
OAuth test still failed on retry. The accepted proof therefore remains 0/25.

A deduplicated 90-day PostHog review showed both signatures were rare but
real, and every one of their 316 executions ran on Depot. Ephemeral-events had
two passed-after-retry executions, no final failures, and durations of 7.2
seconds at p50, 12.1 seconds at p95, and 113.6 seconds maximum. The OAuth test
had two final retry failures, with durations of 17.5 seconds at p50, 28.4
seconds at p95, and 52.0 seconds maximum.

The ephemeral example used unkeyed appends, so the already-bounded
stream-lifecycle recovery could not safely replay them after the target
Durable Object reset for a code update. Each example invocation now generates
one operation id and keys both its ephemeral progress event and durable
completion event. They can replay together across one classified lifecycle
reset without deduplicating a later, intentional invocation.

The OAuth failure exposed a more dangerous boundary. Cloudflare trace
`8a763589c2850186df9ec282966fe487` showed a new Project incarnation call an old
Secret incarnation during rollout. Petshop accepted the refresh and returned
200, but the Secret reset before it could durably commit the rotated token.
Blind replay is invalid because an OAuth provider may invalidate the old
refresh token. Credential-bearing egress now performs read-only exact-version
handshakes across both edge→Project and Project→Secret boundaries before the
request can run. Mismatches, bounded probe timeouts, and one classified
lifecycle reset are counted on convergence; application failures, a second
reset, and the total deadline stay terminal with an explicit guarantee that no
request or refresh ran. The retry fixture also retains its two minted client
identities across Vitest attempts so a diagnostic retry never compares
durable write-only state with unrelated credentials.

The first exact-head preflight for those fixes (`470c34212`, Depot run
`xnwg1jt8jm`, attempt `1qhxbg07m2`) was rejected after 4 minutes 5 seconds
with 15 framework retries. The finalizer still normalized all ten artifacts
into 7,137 PostHog events. This was not isolated-head evidence: the manual
dispatch began while the automatic PR run was still deploying, and the shared
workflow concurrency group cancelled that automatic run one second later.
Cloudflare had created version `461906ad-e4be-48ed-be91-21831bb1eda5` for the
automatic run and version `912796f7-37c7-4a85-9c19-d9c4c1391302` for the
manual run. Both versions then appeared across the test traffic.

That collision nevertheless exposed a real symmetry error in the new guards.
They waited whenever Worker version ids differed, including when an older edge
caller reached a Project or Secret that had already advanced. Rollout safety
is directional: a target older than the caller must wait, while a target whose
Cloudflare version creation timestamp is newer already owns the safe
side-effect boundary. The handshake now carries id plus creation timestamp,
accepts only the same or a provably newer target, records both identities and
the relation in convergence telemetry, and retains string-id compatibility
while old Durable Object incarnations drain. Missing or invalid ordering
metadata never guesses that unequal versions are safe.

The new immutable-head proof remains at 0/25 until this correction passes a
fresh exact-head preview with zero retries. The automatic run must finish
before any manual iteration starts; `workflow_dispatch` and automatic PR
events intentionally cancel each other for the same slot. As in every current
round, each counted iteration is a separate canonical Depot run on the normal
16-core runner, with ordinary artifacts and the PostHog finalizer.

The isolated automatic preflight for the directional correction
(`737107870`, Depot run `7nr3xqfnz7`, workflow `4xz2mgz3td`, attempt
`jpbhzgz72s`) finished green in 3 minutes 56 seconds, but was correctly
rejected with 11 absorbed retries. Its ten artifacts still normalized into
6,976 PostHog events. Several failures came from older callers expecting the
previous `deploymentVersion(): string` RPC contract while a newer target
returned the metadata object; the old comparison rendered that value as
`"[object Object]"` and waited out its 30-second safe-boundary deadline.
Other retry records were the corresponding code-update resets and operations
still running on the old rollout implementation.

Cloudflare explicitly requires Worker↔Durable Object APIs to remain forward
and backward compatible because code updates propagate eventually
consistently. The metadata upgrade now preserves the no-argument string
response forever and makes the directional descriptor opt-in through a
versioned optional argument. A new caller can pass that argument to a new
target for id plus timestamp; the old JavaScript implementation safely ignores
the extra argument and returns its string, while an old caller still invokes a
new target with no argument and receives the string it expects. This repairs
the protocol rather than classifying rollout retries as harmless. The strict
proof remains 0/25 pending a clean immutable-head preflight.

The automatic preflight for that compatible protocol (`e1ea06027`, Depot run
`lm3zvldk49`, attempt `5fgl9pd0k7`) finished green in 4 minutes 3 seconds, but
was rejected with 12 retries from callers already executing across the
one-time protocol transition. Its ten sources finalized into 6,981 PostHog
events. The first manual strict iteration on the same immutable head
(`2qnhnzh7st`, attempt `96q1hwt5v5`) failed after 5 minutes 36 seconds. The
retained raw artifacts prove four Vitest retries plus one Playwright retry;
the old ledger initially reported zero because the failing OS command never
reached the successful-run retry annotation. A time-bounded PostHog query for
that exact workflow run ID found all 6,969 finalized events under the same head
SHA and Depot attempt URL; its `ci test finished` records independently sum to
the same five retries.

That run exposed a real rollout defect in the new read-only guard. Its Secret
version probe retried on the same Durable Object stub after a classified
lifecycle reset, so one stale connection could reject twice and manufacture
the terminal “reset more than once” outcome. Project and Secret guards now
acquire a fresh named stub for every probe and forward the eventual
side-effecting request on exactly the stub whose read-only probe established
readiness. Regression tests prove the failed stub is never used for the
request and that the replacement is acquired once. The GitHub integration
fixture also allocates its project, Secret, App identity, and keypair inside
each Vitest attempt: the previous retry overwrote Petshop's public key while
reusing the first attempt's durable write-only private key, turning the
diagnostic retry into a deterministic 401.

Cloudflare observability showed this was a genuinely unhealthy run rather than
five benign test artifacts: alongside the Secret boundary failure, the slot
recorded code-update resets, repeated `Network connection lost` outcomes,
Durable Object storage timeouts, objects moving machines, and one internal
storage reset. The other passed-after-retry tests overlapped that event burst
and are not being normalized into longer waits or whole-test retries. The
strict streak remains 0/25; the next immutable head must establish whether
fresh-stub recovery removes the app-owned defect while preserving those
platform failures as explicit rejected evidence.

The automatic exact-head preflight for the fresh-stub fix (`9e5867530`, Depot
run `b6cqg50wlk`, canonical workflow `zrb2cnffkq`, job `9pbhn3wxpb`, attempt
`r2ntsxv483`) was rejected after 3 minutes 29 seconds. The OS lane still failed
and the retained raw artifacts contained exactly five framework retries:
onboarding smoke and the two-tab stream Playwright case passed on retry; the
Guestbook catalogue and warm-delivery Vitest cases passed on retry; and the
Ocado integration test failed again. This also validates the corrected ledger
path: it recovered all five retries from a failed command's artifact even
though no successful-run annotation existed.

PostHog independently recorded 10,942 exact-head events under workflow run id
`201023552274857`, all tagged `runner_provider=depot`. The canonical preview
job contributed 6,994 events and all five retries; a second ordinary Depot CI
job on the same head contributed 3,948 events and no retries. Both finalizers
completed. Counted flakethon iterations remain exclusively separate canonical
`cloudflare-previews.yml` runs on the standard 16-core Depot runner; unrelated
same-head CI is useful corroboration but never enters the streak.

The terminal Ocado retry was fixture-induced. Attempt one lost its connection
after durably creating the Secret; Vitest re-entered the test with the same
module-level project and Secret names but a newly allocated echo origin, so
attempt two deterministically rejected the changed egress policy. Each test
attempt now creates all of those durable identities inside its callback.

The two-tab Playwright retry mixed its intended follower-after-kill contract
with a simultaneous cold writer-election and stream-bootstrap race. The first
writer's stream call timed out, leaving the healthy follower with an empty
SQLite mirror and neither page able to observe the creation event. The fixture
now establishes one writer plus the durable creation event before opening the
follower; the tested kill, follower blast, and mirror-convergence sequence is
unchanged.

Cloudflare traces for the same 3m29s window prove the remaining retry cluster
was rollout/storage-wide rather than a reason to relax assertions: 40
`Network connection lost` errors, 27 named Durable Object storage-operation
timeouts, 11 code-update resets, eight generic internal errors, two objects
moved between machines, two keyed-append timeouts, and additional internal
storage-reset references. Fourteen intentional `kill requested` actions were
counted separately. Trace `81a0789810c441796b70a4bd3b1ed45d` tied the warm
delivery retry's internal reference to `ProjectDurableObject`'s
`indexCommittedBatchFacts` method while the processor relay was indexing a
committed batch.

That indexing RPC was idempotent but previously lost the local lifecycle
classification at the RPC boundary. The Project now converts a locally
flagged reset into an explicit plain-data availability result, while
application failures still reject unchanged. Its caller reacquires a fresh
named Project stub and replays once; a second availability interruption
becomes `StreamReceiverUnavailableError`, causing the durable delivery spine
to back off and redeliver instead of treating the batch as poison. A fulfilled
`void` from an old rollout target remains a successful result for
backward compatibility. The strict proof is still 0/25 pending a clean
immutable-head preflight of these three fixes.

The automatic exact-head preflight for those fixes (`ad7fce6f8`, Depot run
`4rgc5pftbj`, canonical workflow `sjfrqsg1nq`, job `kdpcs71096`, attempt
`2fkdnbs6wv`) was functionally green in 5 minutes 8 seconds, but correctly
rejected at 0/25 because five Vitest tests passed only after retry. Its
canonical finalizer retained 6,932 events; a workflow-run-id query in PostHog
independently recovered all five retries, all ten expected test runs, and
`runner_provider=depot` on every event.

The retries were not one class. Two catalogue/egress operations and the
streams example hit explicit code-update resets; the in-flight refresh test
timed out at 120 seconds; and the sandbox egress test timed out at 180 seconds.
A deduplicated 90-day PostHog review found retry rates of 3.36% for the sandbox
egress test, 3.06% for workspace edit-and-push, 1.53% for the refresh race,
1.22% for the redirect proof, and 0.42% for the streams append proof. None is
being normalized by increasing a framework timeout.

Cloudflare trace `22af0431330958c323b78d41fb944ef5` showed the refresh request
had already failed remotely after 1.4 seconds, before reaching the fixture's
OAuth barrier. The test then waited only for that barrier and hid the real
rejection until its 120-second watchdog. Both barrier-based refresh tests now
race the barrier against request settlement and a 30-second synchronization
deadline, release their blocked fixture in `finally`, and annotate fixture,
operation, synchronization, and verification phases. An early request failure
therefore stays the original failure instead of becoming a misleading hang.

Trace `feededbb0763d4e028978dd8b4dd2dd4` showed a sandbox command invoked with
`timeout: 45000` remain inside `Sandbox.exec` for roughly 193 seconds. In
`@cloudflare/sandbox@0.12.3`, that timeout is enforced only after the SDK has
acquired the stream and received its `start` event. OS now owns the whole
post-readiness deadline. A unique container-local guard records the exact
process group; if stream admission misses the deadline, a separate command
installs a cancellation tombstone and performs the same targeted TERM/KILL
proof. It returns 124 only after containment is confirmed, throws explicitly
if containment remains unknown, never destroys the whole sandbox, and never
replays user code. The egress proof now emits fine-grained PostHog phases for
every fixture, file write, command, wait, verification, and cleanup so any
remaining tail names the stalled operation directly.

The streams example had used a new stream path after a failed WebSocket call,
implicitly assuming that a lost response meant append did not commit. It now
keeps one stream path and one idempotency key across its single transport
redial. The keyed append safely deduplicates a committed-but-unacknowledged
call and lets the server replay one classified lifecycle reset; a second reset
or application failure remains terminal. The redirect proof remains
non-replayed because its credential-bearing request crosses an external
side-effect boundary, but now records phases that distinguish setup from the
terminal probe. The strict streak remains 0/25 pending the next immutable-head
preflight.

The automatic exact-head preflight for those changes (`7c4588c80`, Depot run
`00l7zv4v38`, canonical workflow `7mwxwltjdb`, job `dc1bf9fxbf`, attempt
`zbwcnhvgt0`) was fast and functionally green in 2 minutes 56 seconds, but was
strictly rejected with seven framework retries. Its canonical finalizer
normalized all ten expected artifacts into 7,096 events. PostHog independently
recorded the same seven retries under workflow run id `399488891498`, with
`runner_provider=depot` on every canonical event; the separate ordinary Depot
test workflow contributed 3,964 corroborating events and zero retries but does
not count toward the streak.

Five OS Vitest retries and the markdown-preview project fixture overlapped one
rollout/storage incident. Cloudflare recorded 32 OpenTelemetry `Network
connection lost` errors, 16 code-update resets, 15 internal Durable Object
storage resets, keyed-append timeouts, stream-delivery backoff, and the exact
scheduler failure reference in the same test window. Fourteen intentional
`kill requested` events were classified separately. This is rejected
platform-wide failure evidence, not permission to lengthen whole-test
timeouts or accept finally-green retries.

The seventh retry had a narrower test-owned race. In the split-view Streams
case, the exact `/next` stream path logged a tagged Durable Object reset and
the product correctly entered its bounded, idempotent append recovery. The
composer still said `appending` when the test's independent 15-second event
assertion abandoned the operation; the retry began immediately afterwards and
passed. The shared composer helper now waits up to 45 seconds for the append's
terminal state, then requires the expected `appended` or `error` outcome.
Terminal application errors therefore fail immediately, while one supported
rollout recovery can complete without asking Playwright to rerun the test.
The strict streak remains 0/25 pending a fresh immutable-head preflight.

The next exact-head preflight (`687b63177`, Depot aggregate `ng2bqtn110`,
canonical workflow `hr05mwcm50`, job `8nc258wk01`, attempt `qlwwnlhjnv`) was
finally green in 4 minutes 1 second but correctly rejected with seven
framework retries. Its finalizer retained all ten expected sources and
normalized 7,192 events; the ordinary PostHog upload path completed. Four
Vitest cases retried (two rollout readiness probes, one Repo lifecycle reset,
and the 20-script concurrency proof), as did two reactivity Playwright cases
and the SVG preview case.

The 20-script failure localized the remaining systemic defect. All scripts
started together and all became orphaned together about 21 seconds later.
Exact-version Cloudflare traces showed the Capability Host's wake RPC retained
for 20.924 seconds and then failed at the Stream's settlement deadline, even
though the script attempt had already moved its consequential work onto the
runner's independent keepalive. This disproved the settlement callback's
claimed independence: because the callback arrived inside the
stream→subscriber sink call, retaining it also retained that RPC session and
allowed the nested append tree to trap its own acknowledgement.

Current processors now receive an opaque per-delivery settlement ID and send
their terminal verdict through a fresh, one-way call on the processor's own
Stream handle. The callback remains only as a mixed-version fallback: new
Stream→old host, old Stream→new host, and non-platform hosts remain compatible.
The Stream accepts the ID only on the exact live connection, fences duplicates
and late predecessor reports, and retains its native 20-second alarm for a
genuinely missing report. The direct report is not attached to the inbound
sink turn; the runner's existing frame/background keepalives remain the sole
owners of processing work.

The two readiness retries both had the exact Cloudflare-generated shape
`internal error; reference = <24 lowercase alphanumeric characters>` at the
read-only version probe. That boundary now tolerates and counts one exact
platform-reference failure before retrying on a fresh target. A second such
failure, every near-match, and every application error remains terminal; the
successful convergence logs include the platform-failure count. This
classifier is local to deployment readiness and does not broaden the shared
Durable Object availability predicate.

Local validation is green across all 17 tested workspaces. OS has 2,408 passing
tests, six expected failures, and one skip across 245 files; the focused
transport/readiness set has 130 passes and one expected failure. Monorepo
typecheck, lint with zero warnings, formatting, Knip, generated API checks, and
`git diff --check` all pass. The SVG timeout and any independent lifecycle
failure remain proof targets rather than accepted noise. The strict streak is
still 0/25 until the new immutable head completes a clean preflight.

## Round 15 (2026-07-23, post-#2284)

This round starts from merged `origin/main` at
`0d8f96f9298f46590f6a8f3bbae1825e03c9660a`. PR #2284 aligned public project
creation with its real nested birth barriers and added one observable,
pre-session recovery for a spawned CLI's initial WebSocket upgrade. The
recovery boundary cannot replay authentication, capability lookup, or user
code, and application/RPC errors remain non-retryable.

The final #2284 exact-head preview was clean functional evidence: all six
expected E2E sources finalized, all 245 runnable test records passed, and
Depot artifacts plus PostHog recorded zero framework retries, zero
passed-after-retry outcomes, and zero initial-connection recovery markers. It
does not count toward this round's consecutive proof because it is a different
immutable head. It took 359 seconds from aggregate dispatch (346 seconds for
the preview check), which is inside the revised seven-minute stability ceiling
but remains a performance tail to remove after the stability proof.

That run also isolated the leading time floor. OS deployment took 79.45
seconds and OS E2E took 171.99 seconds, while OS Vitest itself took 63.55
seconds. Fresh project creation was held until the deployment-wide Durable
Object rollout clock reached 90 seconds, and Vitest began only after that
boundary plus onboarding smoke settled. Round 15 begins at 0/25 and first
measures unchanged warm-slot runs through the canonical Depot workflow before
changing the rollout critical path.

### Round 15 seven-minute proof and Project description reset

Exact head `a0706e02629ec20ca205fdf12596cbc2b6f0d7f5` produced five consecutive
clean canonical runs in 339, 333, 271, 251, and 411 seconds. The fifth run
(`q5hjb85fr1`) completed in 6 minutes 51 seconds with zero framework retries.
That is direct evidence for the 420-second proof ceiling: the old five-minute
limit would have rejected a complete, clean run, while the revised limit left
only nine seconds of headroom.

Run six (`ngtx6pwk2h`) finished in 241 seconds but is rejected because
`repo-ide-markdown-preview.spec.ts` passed only on Playwright's second attempt.
The first attempt created its project successfully, then the pipelined
`Project.__describe()` call was rejected with `durableObjectReset: true` and
`Durable Object reset because its code was updated.` Exact-version Cloudflare
trace `0bd2b7add32f43a5e61359103b532f4f` places the Project Durable Object reset
about 140 seconds after the OS deployment was recorded—well after the existing
90-second deployment-age gate. Repo and Stream Durable Objects reset in the
same interval. This is therefore deployment-wide lifecycle behavior, not a
markdown-preview assertion failure or a project-creation collision.

PostHog confirms the scope: during the preceding seven days the same explicit
code-update reset reached at least 20 different live test names across
unrelated branches. Cloudflare documents Worker and Durable Object rollout as
eventually consistent over seconds to minutes and provides no finite
deployment-complete barrier for all Durable Object identities. Increasing a
fixed pre-test sleep would add permanent critical-path latency without proving
that a later identity cannot be reassigned.

The product boundary is instead made honest: the read-only Project description
operation now uses the existing Durable Object availability helper for exactly
one observable replay. The whole logical read is repeated so its Project and
Capability Host snapshots remain from one attempt. Only workerd lifecycle flags
or the explicit cross-RPC stream-unavailable contract qualify; application
errors remain authoritative and no mutation can be replayed. The first reset
is logged with project and scope context, and a second failure is returned.
Focused tests cover resets from either Durable Object branch, and the shared
classifier tests retain the no-application-error/no-loop guarantees.

The retry resets the accepted streak to 0/25. Merging current `origin/main` at
`ecc8d1fa48d17eda5e12b9c7ff6f03b75d8d0358` also invalidates the earlier
immutable head, so the next accepted proof starts from the merged corrective
head with the same seven-minute ceiling.

### Round 15 Secret create storage reset

The automatic preview on exact head
`52bfeb9c7d9857d2612ecbcdff294484651f4ba2` was clean in 324 seconds. PostHog
recorded 310 preview and 3,106 unit outcomes with zero failures or retries. It
is baseline evidence rather than a counted marathon iteration because it was
not dispatched into the immutable proof ledger.

The first ledgered run (`bmd2z9ncsd`, attempt `hs0vk1fzrm`) completed in 252
seconds but is rejected. `waitrose-session strategy: username/password secret
mints on first use, re-mints on 401, session works on the API` passed only on
Vitest's second attempt after Cloudflare returned `Durable Object storage
operation exceeded timeout which caused object to be reset.` The failure was
therefore unrelated to the seven-minute ceiling.

The raw Vitest artifact and exact-version Cloudflare events agree on the
boundary. Project `prj_17684080138441f18be4338ddcb1be0e` was created and
described successfully; its following `Secret.create` ran from
`14:22:59.842Z` to `14:23:34.111Z` and failed after 34.269 seconds. The test
retry addressed the same project and secret, and the repeated create completed
in 449 milliseconds. At the same instant, a different project recorded a
36.611-second project-api-key Secret seed reset. The paired stalls rule out a
Waitrose assertion or credential failure and localize the incident to Secret
Durable Object storage availability.

PostHog supplies the recurrence bound. The named test ran 224 times in the
available 30-day window: seven runs retried (3.12%) and two failed after their
retry. Its prior errors include stream wait and Durable Object storage resets.
The same storage-reset family reached unrelated stream lifecycle, dynamic
worker, remote-app, and browser tests, so changing this test's timeout or
quarantining it would only move the symptom.

`Secret.create` already documents and implements the necessary replay
semantics: the birth append is idempotency-keyed, an identical-policy duplicate
keeps the first material, and a different egress, refresh, or visibility
policy still fails. The missing piece was the outer Secret RPC boundary. It now
uses the existing availability helper for exactly one observable replay while
workerd's lifecycle flags are still present. Application rejections are never
replayed, the first reset is logged with project and path context, and a second
failure remains authoritative. Focused tests cover both lifecycle recovery and
the application-error exclusion; the full OS unit suite and typecheck pass.
The rejected run resets the consecutive counter to 0/25.

### Round 15 shared Playwright admin connection

Exact head `eb887acb553a66eb5bfe7c4402807ff429457ea9` first passed two
canonical runs in 275 and 320 seconds with zero retries. Run three
(`mv74spgz2j`, attempt `x6zqb8b8jj`) completed in 344 seconds but is rejected:
`stream-resume-after-suspend.spec.ts` passed only on Playwright's second
attempt after its control case reported `WebSocket connection failed.` The
accepted streak therefore remains 0/25.

The retained Playwright trace localizes the first failure before navigation or
any project RPC. The fixture project
`prj_9860ba1c2eb34ad39cd4bcc76663fbce` was created, described, and made ready
successfully. Immediately afterward, `connectAdminItx` failed its initial
WebSocket dial. Exact-version Cloudflare traces contain the successful fixture
creation and simultaneous successful sessions from other tests, but no Worker
invocation matching this failed dial. The connection therefore died locally
or at the edge before the OS Worker accepted it; the named stream assertion
never ran.

PostHog confirms that the victim test is incidental. In the available history,
the exact generic connection error occurred three times across two unrelated
Playwright files: this stream control case and two REPL catalogue cases on
other branches. All three use the shared `connectAdminItx` helper and all three
passed on one framework retry. The stream control case itself had 196 recorded
attempts across 186 workflow runs; its three other historical failed attempts
were distinct stream-wait timeouts, not this transport signature.

The shared Playwright helper now uses the same bounded `connectItxReady`
boundary already proven for the CLI. It may make one fresh dial only before a
Cap'n Web session exists, so authentication and test operations cannot be
replayed. Project-fixture creation uses the same safe boundary before issuing
`Project.create`. Any recovery adds an `itx: initial connection retry`
Playwright step, a test annotation, and the structured
`[itx-initial-connection-retry]` diagnostic with the original error and
timings. Those records flow through the canonical artifact into PostHog, while
the marathon ledger explicitly counts the structured marker and rejects the
run. A second dial failure and every post-session failure remain authoritative.

### Round 15 orphaned append, Artifacts 503, and signup recovery

Canonical exact-head run `hrtfl6plzr` (attempt `dhkmkf2p26`) on
`865060fa5644bf2703130611cb9a0d3bf6ee4431` completed in 302 seconds, but is
rejected with three framework retries. The accepted streak remains 0/25.
Artifacts and exact-version Cloudflare telemetry separate the three causes;
none was fixed by increasing a test or project-creation timeout.

The Streams Example relative-path case lost the native Durable Object RPC
acknowledgement for its first append. The call stayed unresolved for the
test's full 30-second budget, then completed after Vitest had already timed out
and continued leaking the abandoned attempt's later appends. The append was
not CPU-bound and the retry completed the complete case in about six seconds.
Every path-resolution append now carries an idempotency key, and the shared
Stream RPC target gives keyed native append attempts a 10-second
acknowledgement deadline. A silent attempt is observed and disposed if it
eventually returns, while the existing availability boundary performs exactly
one replay with the same keys. Unkeyed appends are never deadline-replayed.

The clean-close Playwright case never reached its named assertion. Its fixture
project `prj_e8fece330f4b46b49f812ab0ade21804` completed identity, root birth,
and every sibling birth barrier, then waited 99.201 seconds for
`project/ready`. The retained journal supplies the durable explanation:
`/repos/config` recorded `repos/create-failed` with
`HTTP Error: 503 Service Unavailable` at offset 9. The Artifacts client had
flattened the transient response into a plain Error, so the repo processor's
code/name-only classifier permanently poisoned the repository and no
`repos/created` certificate could make the project ready. The classifier now
recognizes only transient Artifacts HTTP statuses (including the live 503
shape) through wrapped causes and re-enters ordinary durable redelivery.
Domain HTTP failures such as 404 still settle fail-closed. Focused recovery
tests prove that the 503 writes no failure fact and a successor attempt writes
one terminal `repos/created` fact.

The new-user UI case exposed a separate navigation defect. The root
deployment-status probe returned `unknown`, so the root decision sent the user
to `/projects`. That page successfully created project
`prj_445316f275f34223b49486ebf5f8346b` and made it ready in about 4.9 seconds,
but remained on the list until the 60-second composer assertion expired. A
single unknown project now follows the same welcome destination as a missing
project. Server-side nonblocking birth is attempted first; if its probe or
birth call fails, an explicit `ensureBirth` handoff lets the authenticated
welcome page issue the same idempotent nonblocking create once. The user is no
longer stranded after successful recovery.

Focused tests (65 cases), both affected package typechecks, targeted lint and
format checks, and the full OS unit suite are green locally. This is diagnostic
and regression evidence only; a new immutable head must restart the canonical
25-run proof.

### Round 15 orphaned wake settlement and false root-append deadline

Canonical exact-head run `mf4v6fm81q` (attempt `xswl4x4d5w`) on
`420eac47ba9c853f5cad15a429aa6a59eada4909` completed in 331 seconds and all
tests eventually passed, but the run is rejected because it used three
framework retries. The accepted streak remains 0/25.

The worker-alarm retry exposed a mistake in the preceding keyed-append
hardening. Its first project continued through birth and became ready, while
the public root append exhausted two artificial 10-second acknowledgement
deadlines. Root birth is a larger durable saga whose callers already own
explicit 90–100-second end-to-ready bounds; imposing the ordinary stream
append deadline inside that saga creates a false failure under load. Keyed
root appends are therefore excluded from deadline replay. Keyed non-root
appends retain the bounded recovery, and unkeyed appends remain non-replayable.

The repo-commit retry was not a slow commit. On its first pooled project,
`prj_66837522b9fd4a71bb551fb96a7c9205`, durable execution
`494d2b81-4750-4e59-b6d1-ae75209c6501` was requested at
`16:52:08.683Z`, but the capability-host processor did not record
`script-run-started` until `17:01:42.665Z`; it settled successfully at
`17:01:46.475Z`. That is a 9-minute-34-second delivery gap before user work
began. The retry used replacement project
`prj_f906e62453b949d6b669724b90addc45`, started in 838 milliseconds, and
settled in about 4.4 seconds.

The gap came from an unbounded transport state in the wake lane. Wake delivery
is deliberately one-way and reports its acknowledgement through an independent
`settleDelivery` capability. A lost settlement callback that also failed to
raise `onRpcBroken` left the predecessor connection authoritative until the
roughly ten-minute idle teardown, so its durable cursor could not be
redelivered. Each pending settlement now arms the Stream Durable Object's
native alarm for 20 seconds. Expiry is an observable
`StreamReceiverUnavailableError`: the cursor stays put, bounded backoff is
recorded, the orphaned connection is closed, and a successor re-pokes from the
durable checkpoint. Late predecessor settlements are fenced. The deadline uses
the native alarm rather than an actor timer, so it does not retain the current
JS-RPC turn.

The third retry was a dynamic-worker runtime failure with platform reference
`efqgrnq1347q3bs8in6q386a`. Durable execution
`9578a99f-b22b-42e5-bf7b-5ea8d9ec00dc` started normally and settled failed
about 2.1 seconds later; its replacement test project passed. This is not
silently reclassified or generically replayed because `runScript` may contain
mutations. It remains a proof target: recurrence in the restarted marathon
must be localized below the user-code boundary before any recovery is added.

The two new regressions pass with the complete 33-file Streams unit set
(381 passed, one expected failure), the affected app typecheck, targeted lint,
and formatting checks. This rejected run resets the proof to 0/25; only a new
immutable head can restart it.

## Round 14 (2026-07-23, post-#2275)

PR #2275 made preview worker builds fail closed when the dependency installer
returns warnings instead of an executable bundle, and made deployment wait in
parallel for the exact SHA-pinned `pkg.pr.new` SDK package. Its final exact-head
preview check ran every runnable suite in 240 seconds, and PostHog's finalizer
matched all 6/6 expected sources. One OS Vitest case nevertheless passed only
after retry, so the run is rejected and the strict counter remains 0/25.

The retry was `Project worker processEventBatch receives events from every
project stream and can cross-post`. Its first project failed the public
15-second create deadline after 14.308 seconds of the remaining ready budget;
the whole-test retry created a different project and passed. This was not a
near-miss followed by harmless background completion. Exact-version trace
`4d603e1afeb62f5f959255504b895244` shows the abandoned first project's config
repository processor still waiting at offset 7 and eventually reporting
`waitUntilProcessed timed out after 59517ms`. Its terminal stream appends
completed around 65 seconds after `Project.create` began.

PR #2273 had introduced an inconsistent timeout hierarchy: a 15-second public
project-create deadline wrapped a 60-second sibling-birth barrier inside a
75-second processor acknowledgement, and explicitly expected a whole-test
retry to redial. The corrective change removes that retry-dependent contract.
Sibling birth now owns one shared 75-second budget, the Project processor owns
90 seconds, and the public entry-to-ready operation owns 100 seconds. Healthy
creates still return immediately; the original caller now observes either the
original fully ready project or one bounded failure. The existing
`os-cold-create-latency` task retains the separate obligation to eliminate this
tail rather than treating the upper bounds as latency targets.

The corrective PR's first exact-head preview check was technically green but
is also rejected. It took 314 seconds and
`catalogue example "provide-live-flattened" runs identically across runtimes`
passed only on Vitest's second attempt. The first attempt's spawned CLI exited
with `WebSocket connection failed`; the exact-version Cloudflare trace set has
no corresponding accepted `/api` request or server error. That localizes the
failure before the server accepted the WebSocket upgrade, not in the named
catalogue example.

PostHog bounds both recurrence and scope. The named case ran 191 times in the
available window and retried once, but the matrix as a whole recorded 38
retries spread across unrelated examples. PR #2169 recorded the same spawned
CLI signature on `repo-read-file`. The example names are incidental: every CLI
case inherited one unobserved, one-shot initial transport dial.

The fix is below the test and above user code. The Node client can wait for the
initial WebSocket `open` event and, when explicitly requested by the CLI, make
exactly one fresh dial after a failed upgrade. This boundary ends before a
Cap'n Web session, authentication call, or user operation exists, so it cannot
replay side effects. The CLI emits a structured
`[itx-initial-connection-retry]` record with the original transport error and
timings; the matrix turns that into a PostHog `e2e-phase` retry annotation.
Application and RPC failures after connection are never retried.

Local transport tests prove first-upgrade failure then success, no retry after
an application failure, and a hard two-dial ceiling. Against the rejected
run's exact OS Worker version, all 27 catalogue examples passed with
`--retry=0` in 67.68 seconds and emitted no connection-retry record. The
probe-based draft took 74.93 seconds; it was discarded because an extra RPC
round trip was unnecessary. The strict full-pipeline counter remains 0/25
until a new immutable head completes without any framework or transport retry
and below the seven-minute ceiling.

## Round 13 (2026-07-23, post-#2271 and #2273)

PR #2271 removed a cyclic Durable Object RPC lifetime from durable stream wake
delivery. Wake batches are now one-way and carry an independent one-shot
settlement capability. Missing settlement leaves the durable checkpoint
authoritative, delivery failure and broken transport share the same bounded
backoff/park machine, and late signals are fenced to the connection that
created them.

Its final exact-head preview ran every canonical suite in 227 seconds with zero
failures or absorbed retries: Depot workflow `1w2np2p7w2`, job `2xswh11402`,
attempt `6kl9w6n7m7`. PostHog recorded 3,342 passing final test records, seven
pre-existing explicit skips, and no failed or retried records. The formerly
65-second `journal-is-the-record` Playwright case completed in 11.232 seconds;
its Vitest equivalent completed in 7.639 seconds.

The first post-merge proof head `31f072d6…` then produced two clean runs (285
and 230 seconds) before run 3 absorbed one retry in `workspace.itx.e2e.test.ts`
after Cloudflare returned opaque internal reference
`jofnmc53etthqc74kfntuo36`. The harness rejected that otherwise-green
234-second run. A fresh proof produced two more clean runs (245 and 231
seconds), then run 3 failed in 311 seconds with 13 retries and three hard
project-creation failures.

PostHog and exact-version Cloudflare traces localized that failure to the
Artifacts create/read consistency boundary. Three independent config
repositories reported an internal create error, then `ALREADY_EXISTS`, while
immediate reads still returned repository-not-found. Failed-run
`artifact-get-or-create` p95 was 39.54 seconds versus 2.59–3.16 seconds in the
adjacent clean deployments, and 30 downstream durable stream deliveries failed.

PR #2273 removed that race. The authoritative initial write token returned by
`ARTIFACTS.create()` now seeds the repository directly; the normal path no
longer performs an immediate `get()` plus `createToken()`. Only the ambiguous
`ALREADY_EXISTS` case uses one explicit, bounded recovery barrier. Public
project creation now has one 15-second entry-to-ready deadline, allowing the
framework's single test retry to redial while already-committed durable work
finishes.

The final #2273 exact-head preview was genuinely green in 247 seconds: all five
apps deployed, all 310 tests ran, and none failed. Two explicit
`stream-wait-timeout` outcomes recovered on the single test retry, so that run
accepted the product fix but does not count toward the zero-retry streak.
PostHog's finalizer matched all 9/9 expected sources. Exact-version Cloudflare
traces showed 20/20 successful `artifact-get-or-create` operations (p95 2.237
seconds, max 4.527 seconds), no normal-path `artifact-token` call, no durable
sink delivery failure, and no Artifacts error.

The strict consecutive counter now restarts at 0/25 on a fresh immutable proof
head based exactly on merged `origin/main` at
`b5fbfdee44234c69226cad52b14fb0440c142e13`.

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

### Round 12 rejected attempt: self-alarm readback races a due alarm

Run 1 on the initial proof head was clean in 281 seconds (Depot run
`zq6s3vngt8`, attempt `sslv41jkrl`). Run 2 completed in 250 seconds but
`stateful-worker-alarm.e2e.test.ts` failed once and passed on Vitest's single
retry (Depot run `fgl4xv672n`, attempt `pf1mx7sj0s`). The harness rejected the
run and reset the streak to 0/25 even though GitHub's ordinary check was green.

The failing assertion expected `armSelf(3_000)` to return an armed timestamp
but received `null`. This was a test race, not a missing alarm: the worker
computes the due time before `ctx.storage.setAlarm` crosses the facet, project
itx, and outer `StatefulWorkerDurableObject`; its following
`ctx.storage.getAlarm` is another traversal. Cloudflare traces show the
self-arm invocation already in flight by `04:09:16.843Z`, while the outer
Durable Object did not receive `setAlarm` until `04:09:19.318Z`. About 2.5 of
the test's 3 seconds had therefore elapsed before the real alarm was armed,
leaving its readback free to race normal alarm consumption.

PostHog shows 131 executions of this test since 2026-07-22: 129 passed first
try and 2 absorbed a retry. The normal duration was 38.7 seconds at p50 and
45.8 seconds at p95; the earlier retried execution took 142.4 seconds and this
one took 75.3 seconds. The fix separates the two contracts already present in
the test. The first alarm continues to prove delivery, deliberate handler
failure, and native retry. Self-addressed arming now uses a safely non-due
alarm, proves the worker-side and host-side readbacks equal the exact scheduled
time, and immediately disarms it. A second near-term fire added no distinct
platform coverage and made a due timer the synchronization primitive.

### Round 12 proof restart after #2270

PR #2270 merged that alarm-test fix to `main` at
`78ba8ad61b3eeeba0cbdd77193510061f8466865`. Its final exact-head preview check
ran all five app suites with zero failures and zero retries in a 254-second
Depot run envelope: run `gdkz9dw86w`, attempt `c7zv439zvz`. The changed alarm
test passed first try in 33.4 seconds.

PostHog recorded 310 preview outcomes and 3,046 unit outcomes on that head with
zero failures or retries. Both finalizers were complete: the preview job found
all 9 expected artifact sources, and the unit job found all 10 expected
workspaces. The `depot`, `github-actions`, and `github-reviews` source syncs
were all fresh and healthy.

That run accepted the fix before its squash merge; it is not part of the
post-merge consecutive proof. The strict counter restarts at 0/25 on a fresh
PR head based exactly on `78ba8ad61b3eeeba0cbdd77193510061f8466865`.

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
`connection-opened` telemetry fact advanced the raw stream to offset 6;
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
