# Local verification — updated 5 September 2026

This is local workerd evidence, not evidence from a deployed preview. There is
no claim yet about production throughput, CPU, eviction recovery, or an
alternative deployment runtime.

The earlier 4,999-line checkpoint has a [CPU profile and
concurrent-writer/live-reader measurement](current-profile-and-live-delivery.md).
All 302,640 measured events pass replay; the live subset additionally matches
receipts and subscription envelopes. Concurrent batch writes expose roughly
1.3-second p99 observed delivery lag. A [matched scheduling diagnosis](live-reader-scheduling.md)
then checks another 400,000 events, including a 208,000-event live subset.
Temporary pre-commit timer yields reduce local lag to 7–13 ms at roughly
27% lower write throughput with a reader; restoring the source brings the
lag back. The [subsequent retained change](live-reader-fairness.md) adds the
reader-aware yield and a public regression within the same 4,999-line budget.
Final-source probes deliver at 7–8 ms p99 lag with zero observed backlog;
all 96,000 events replay and 48,000 live envelopes match receipts. Earlier
three-reader probes check another 128,000 events and 384,000 live envelopes,
including delayed ACKs. Slow readers remain window-limited. These local
tradeoff measurements are separate from the now-34-test suite and do not
establish deployed latency or CPU efficiency. No instrumentation is retained.

The subsequent [current-source CPU measurement](fairness-cpu.md) separates
unprofiled main/proxy/Wrangler process CPU from Inspector hotspot sampling.
All 768,000 events replay, including 384,000 live/receipt comparisons. Median
main-workerd CPU is 86.1 → 115.0 µs/event when an immediate-ACK reader is added
under the retained scheduling policy. Unprofiled live p99 remains 7–8 ms with
zero observed backlog. This is the combined reader/fairness path's local cost,
not isolated timer cost or Cloudflare billable CPU. No source change or
full-suite rerun accompanies it.
A subsequent [read-page allocation experiment](read-page-cost.md) is rejected:
encoder reuse does not improve median live-reader CPU and is reverted. All
1,152,000 measured events replay, with 576,000 matching live envelopes; 39
additional boundary-probe events preserve emoji/escaped-string page sizes
and single oversized-event progress. The runtime source is restored exactly
and remains 4,999 lines; this is not another full-suite checkpoint.

The [canonical-validation follow-up](canonical-validation-cost.md) removes one
duplicate whole-envelope JSON traversal while preserving native-RPC rejection,
batch rollback, and duplicate semantics. All 576,000 timing-workload events
replay, but the reverse control weakens the initial improvement: no reliable
5–8% speedup is claimed. Final boundary probes pass and the full 34-test suite
passes again, including a stronger loaded-worker fetch-gate bypass attempt.

## Public-network suite

Start an isolated local fixture in one terminal. These literal credentials are
synthetic test values, never deployment credentials:

```sh
fixture_dir=$(mktemp -d)
pnpm --dir packages/v3/project-core exec wrangler dev --local --port 8799 \
  --persist-to "$fixture_dir" \
  --var EGRESS_KEY:QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE \
  --var EXPERIMENT_ADMIN_TOKEN:synthetic-egress-admin-token --log-level debug
```

Run the suite in another terminal:

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  LIVE_READER_MAX_BACKLOG=256 \
  pnpm --dir packages/v3/project-core test
```

Latest combined checkpoint: **34 passed, zero failed/cancelled/skipped**, in
20.94 seconds after the canonical-validation simplification and stronger
loaded-worker fetch-gate test. [Exact proof and limitations](canonical-validation-cost.md).
`LIVE_READER_MAX_BACKLOG=256` selects the measured local concurrent-stream
budget, not a universal network guarantee. Omit it for the default functional
ceiling of the entire 1,600-event burst. The earlier fairness checkpoint was
followed by targeted checks of a whitespace-default test adjustment; this
latest full run includes that adjustment. [Fairness red/green proof and limits](live-reader-fairness.md).
The lifecycle case fills 64 slots, keeps one reader healthy, expires 63 stalled
readers, and reconnects/replays through their replacement slots. Three extra
four-project retry/halt stress runs passed at the preceding ACK-lease checkpoint;
they were not repeated for this change. The earlier transaction-local trust
checkpoint passed 33 tests in 20.71 seconds.
[Deadline proof and the remaining transport tail](stream-ack-deadline.md).
Port 8799 is a separate local Wrangler instance with synthetic
`EGRESS_KEY` and `EXPERIMENT_ADMIN_TOKEN` bindings, not product credentials.

Three defects were found and fixed before the earlier 10.41-second checkpoint:

- Processor retries could stop at `attempts: 2` with an overdue `retry_at`.
  An initial fix replaced stale alarms, but a fresh-state run then exposed a
  native alarm-manager mismatch. The final fix gives the alarm invocation
  ownership of the shared processor run and its durable re-arm: `alarm()`
  awaits both; append/request paths still start processing without waiting.
  Existing due alarms are left for the runtime to deliver, not overwritten.
  A later full run still failed 31/32: nested processor appends could re-arm
  the previous retry deadline. Now only the finishing run schedules processor
  wake-ups; nested scheduling preserves an intent for the final handoff.
  The five processor tests and five extra four-project retry/halt stress runs
  pass. [Causal trace and ownership proof](alarm-ownership.md).
- Secret encryption authenticated receipt metadata, but decryption accidentally
  authenticated the entire stored row, including nonce/ciphertext. Both sides
  now explicitly select the same associated-data fields. A real HTTPS echo of
  a synthetic header value proves successful decryption and substitution.
- Rejected native RPC promises retained their session pipelines. The core's
  call boundary disposes only the failed native promise and rethrows the error;
  successful returned capabilities are untouched. A minimal DO → static
  WorkerEntrypoint repro also fails under Wrangler 4.129.0. The original full-core
  log assertion changed from three hung cancellations to zero. [Red/green
  differential and containment scope](loaded-worker-rejection.md).

**The retained local operational checkpoints are green within their tested scope.**
At the earlier retry checkpoint, the full suite ran alongside five extra repetitions of its four-project
retry/halt test. Fresh debug log `wrangler-2026-09-04_23-19-02_705.log` has
78 deliberate negative-fixture exceptions (75 processor failures and three
mounted-method failures), zero additional async/hung cancellations, zero
`NOSENTRY` alarm mismatches, and zero leftover diagnostic instrumentation.
Two WebSocket peer-disconnect diagnostics correspond to the explicit
lending/disposal tests; these are
expected connection closures, not claims of automatic reconnect. A prior
rerun failed entirely with `ECONNREFUSED` because its disposable dev server had
stopped; restarting it restored the suite. That failed invocation reached no
application handler and is not hidden as a flaky-test retry.

The earlier 32-pass log with seven extra cancellations and the later 31/32
alarm-race failure are retained in the linked diagnoses. Earlier apparent
clean reductions used quieter logging; they were corrected, not counted as
negative evidence. No deployment or performance claim follows from this
local repair.

The preceding single-INSERT checkpoint is a fresh full suite, not a repeat of
those five stress runs. Its debug log `wrangler-2026-09-04_23-45-55_566.log`
contains 18 deliberate fixture exceptions (15 processor failures and three
mounted-method failures), two expected peer closures, and zero extra async/hung
cancellations or alarm mismatches. Full append/retry/replay envelopes agree;
both old and new stored envelope formats pass after a local process restart.

The preceding combined-policy-read checkpoint uses fresh runtime log
`wrangler-2026-09-05_00-03-16_829.log`: 18 deliberate fixture exceptions,
15 classified processor failures, three mounted-method failures, two expected
peer closures, zero hung/extra async cancellations and zero alarm mismatches.
The new tenth provenance case covers rotation within an atomic batch, rollback,
stale-key rejection and immutable historical verification. Its initial fixture
error and the strengthened tampering assertions are documented in
[trust-read evidence](trust-read-cost.md), not passed off as a fixed runtime bug.

The preceding ACK-lease checkpoint uses fresh log
`wrangler-2026-09-05_00-23-49_073.log`: 54 deliberate fixture exceptions
(48 deliberate retry failures, three broken-source failures, three mounted
rejections), 51 classified processor failures, two expected peer closures,
zero extra async/hung cancellations and zero alarm mismatches. It includes
the full suite plus the three extra four-project retry stress runs.

The preceding transaction-local trust checkpoint uses fresh persistence
`/tmp/project-core-transaction-suite-z7Bav5` and log
`wrangler-2026-09-05_00-41-37_191.log`: 18 deliberate fixture exceptions
(12 retry failures, three broken-source failures, three mounted rejections),
15 classified processor failures, two expected lending/disposal peer closures,
zero extra async/hung cancellations and zero alarm mismatches. The signature
policy tests also passed before and after the refactor on the benchmark runtime.

The preceding fairness/consolidation checkpoint uses corrected-fixture log
`wrangler-2026-09-05_01-42-15_504.log`. Its two full suites produce 36 intentional
fixture exceptions, 30 classified processor warnings, four expected
lending/disposal peer disconnects, and zero extra async/hung cancellations,
alarm/scheduler errors, or subscription-callback failures. The initial
31/33 fixture run had a mistyped synthetic key that decoded to 35 rather than
32 bytes; its explicit configuration failure and correction are preserved in
[the fairness evidence](live-reader-fairness.md), not hidden as a product fix.

The latest canonical-validation checkpoint uses log
`wrangler-2026-09-05_02-48-29_694.log`. Its full suite and three Date-padding
probes account for all 24 source exception reports: 18 deliberate suite
failures and six source/native-membrane validation reports. No extra
hung/cancellation, alarm/scheduler or stream-callback diagnostic is found.
Two expected lending/disposal peer-disconnect records are classified separately.
The owned runtime is stopped with manual SIGINT (exit 130); this is not a
graceful-restart or new recovery proof.

The other cases cover paths and isolation, batch rollback and repository CAS,
native loaded workers and real gated HTTPS fetch, stream acknowledgements,
plural signatures and lockdown, capability lending/disposal, MCP, and exact
approval/deny/expiry/replay semantics. They do not prove every adversarial or
deployed lifecycle case. The seven egress tests additionally cover synthetic
write-only control/receipts, exact-origin restrictions, secret rotation, manual
redirects, and a followed redirect whose new origin is denied before secret
release. Echo tests depend on `httpbin.org`; basic harmless GETs use
`example.com`. An allowed server can reflect a secret, so write-only API access
is not a claim of response taint tracking.

## Browser

An isolated headless Playwriter session visited the local tutorial and console:

- Browser-generated Ed25519 signature appended successfully at verification
  level 1; canonical signing context includes the project, not only `/`.
- Following a stream received two events appended by an independent HTTP
  client. Each page was acknowledged, allowing the next page to arrive.
- Tutorial navigation shows concrete code and checkout source paths. It does
  not link to nonexistent public `/src` routes.
- No console errors in the final inspected browser state. A source reload
  closes the live connection and displays `not connected`; this is not a claim
  of automatic reconnect.

[Signed-events tutorial screenshot](tutorial-signed-events.png) and
[mobile tutorial screenshot](tutorial-mobile.png) were visually inspected.

## Local restart and throughput

A separate [process-restart probe](local-restart.md) passed: committed events,
repository revision, mounted code, signature policy, and WebSocket replay
survived; a pending processor retry resumed without a new append. This was a
graceful local stop/start, not a deployed eviction or abrupt-crash test.

A later [abrupt recovery probe](abrupt-recovery.md) passed two SIGKILL cases:
a pending retry resumed autonomously and halted at three attempts; a delivery
killed after its derived event committed replayed without duplicating that
effect and advanced its cursor. No post-restart project request preceded the
autonomous recovery markers. Repo code, signed history, duplicate receipts,
and WebSocket replay also passed. This is not a crash inside a synchronous
commit, machine failure, or deployed eviction proof.

The separate [approval/secret recovery probe](egress-recovery.md) then passed
on the transaction-local-trust 4,999-line checkpoint across two SIGKILL restarts. Undecided requests,
signed allows/denials, consumed approvals, and rotated secret revisions all
retained their public behavior. Permitted synthetic echoes proved decryption
after restart. Full history and duplicate receipts stayed identical; all
three logs had zero unexpected diagnostics or fixture plaintext values.

The latest [processor recovery check with live readers](fairness-recovery.md)
uses the retained reader-aware-yield/consolidation source. Both SIGKILL cases
pass: an effect committed before cursor advance replays without duplication,
and a pending retry resumes and halts at three attempts. Each autonomous marker
precedes the controller's first project request after boot; that request's
inspection confirms completed or terminal progress. OPEN readers received and
ACKed all pre-kill envelopes; fresh connections resume from offset 133.
Repository head/list/pinned-read values and mounted code survive. The three
logs have only the three deliberately induced retry exceptions and their
matching classified warnings, with zero extra cancellation/alarm diagnostics.
No implementation change or full-suite rerun was needed for this probe.

The first [HTTP throughput baseline](local-throughput.md) measured three rounds:
roughly 6,100–6,300 events/sec for sequential 128-event batches with 256-byte
payloads, versus 288–295 events/sec for individual requests. All 385,500 events
were read back with consecutive offsets. These are shared-machine loopback
measurements with debug logging; no deployed CPU or capacity claim follows.

A later [existing-core comparison and CPU sample](append-cost.md) identified a
redundant SQL update. Removing it raised median 100-event batch throughput by
13–18% in three before/after rounds. Singleton throughput did not improve, and
the reference remains substantially faster. The local profile is sampled
leaf-frame evidence, not billable CPU/request or deployed capacity.

The [combined trust read](trust-read-cost.md) then improved median batch rates
another 16–17% in a separate matched before/after run. Both runs replayed all
63,000 events. Neither measurement establishes deployed CPU efficiency or
meets the still-substantially-faster existing core's throughput.

The [transaction-local trust read](transaction-trust-cost.md) improves
median batch rates a further 18.1% JSON / 17.3% Capnweb in its matched run:
about 8,970 / 8,619 events/sec. All 126,000 before/after events passed full
readback. It adds one line, retains per-event policy decisions, and updates
the local policy after each actual trust-setting write. The processor SIGKILL
probes preceded this refactor; the separate approval/secret SIGKILL probe uses
that checkpoint. The subsequent live-reader processor probes described above
use the current source, while approval/secret SIGKILL checks have not been
repeated after the reader-aware scheduling/consolidation change.

## Outstanding acceptance

Type checking, scoped repository lint and formatting pass. The strict counter
is **4,999 raw authored lines**, including tests, UI, configuration and scripts.
The compile-only contract also proves that `Scope.cd(...).readEvents()` remains
typed/pipelinable and an undeclared remote method is a TypeScript error.
Any further lifecycle fix requires another full suite and fresh log audit.
Deployment access policy still needs a user
choice. The [deployment preflight](deployment-preflight.md) verifies local
bundling, expected runtime bindings and the proposed remote name's absence;
it also identifies the missing protected-preview HTTP/WebSocket test transport.
No upload or policy change occurred. Raw WebSocket subscribers now have a tested ACK deadline and slot
replacement/replay; idle native transport shutdown can still trail by ten
seconds. This is not a proof of bounded native memory under reconnect churn.
Deployment, synchronous-commit crash/eviction recovery, hostile-load/backpressure,
deployed throughput and CPU comparisons remain separate required evidence. Collaborative workspaces,
file merge/CRDT semantics, project app permissions, and TypeScript compilation
and bundling are documented designs rather than completed implementations.
