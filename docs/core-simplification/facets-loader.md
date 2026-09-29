# Facets, residency, alarms, and dynamic Workers

Audit scope: `cfd8a1d36` (main), read-only. This examines facets, lifecycle
claims and alarms, and confined dynamic Workers.

## Executive finding

The durable-object core here can be stated simply: a context owns a log and one
alarm; a facet is a named child with configuration and an optional durable lease;
the child uses either a first-party class or a confined dynamic Worker. The
present code represents that lifecycle with seven independent durable key
families and numerous mirrored in-memory maps. Consolidating these into one
per-facet lifecycle record is the highest-value simplification that preserves
the behaviour.

Do not delete the main platform workarounds. The expensive-looking stop/start,
alarm-watch, and poisoned-loader paths have concrete deployed evidence and
bounded removal criteria.

## Documented upstream defects

| Behaviour                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                        | Current bounded handling                                                                                                                                                                                                                                                                                                                                                                                                                                      | Conclusion                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A written facet that stops can reset its parent on the next storage commit | [`facet-host.ts:96`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:96); raw deployed-only `createFailing` pin at [`facet-abort-storage-reset.e2e.test.ts:24`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/e2e/facet-abort-storage-reset.e2e.test.ts:24).                              | Abort and successor startup are held by `blockConcurrencyWhile` at [`facet-host.ts:526`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:526); every old facet is started before a newborn context's first write at [`iterate-context-durable-object.ts:454`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/iterate-context-durable-object.ts:454). | Preserve the no-commit-between-stop-and-start invariant.                                                                                                                                                                                     |
| An armed native alarm can remain undelivered while the object is held      | Stand-alone repro and measured distribution at [`alarm-coordinator.ts:20`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/alarm-coordinator.ts:20).                                                                                                                                                                                                   | Re-arm at birth or while already held, at most three times, then report an issue: [`alarm-coordinator.ts:156`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/alarm-coordinator.ts:156), [`alarm-coordinator.ts:182`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/alarm-coordinator.ts:182).                                                                           | Keep it isolated as an `AlarmWatch`; production quiet telemetry permits removal after 28 days at [`prd-fault-alarm.ts:116`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/scripts/ci/prd-fault-alarm.ts:116). |
| A Worker Loader entry whose `getCode` failed stays poisoned                | Upstream behaviour and recovery boundary documented at [`worker-loader.ts:118`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:118); spelling/look-alike tests at [`worker-loader.test.ts:537`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.test.ts:537). | Mark dead, resolve outside the loader, use one fresh generation, sharing recovery: [`worker-loader.ts:355`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:355).                                                                                                                                                                                                                           | Preserve generation recovery, but consolidate classification and caller policy.                                                                                                                                                              |
| RPC values can pin a context after client use                              | Deployed observations and session-release layers at [`residency.md:25`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/docs/residency.md:25).                                                                                                                                                                                                             | Release in-memory pins after 30 s; reset unclaimed loaded facets after 60 s: [`residency.ts:141`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/residency.ts:141), [`residency.ts:204`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/residency.ts:204).                                                                                                | Keep: a pin dies with its incarnation, while a claim must survive it.                                                                                                                                                                        |

These are evidence-backed platform workarounds, not speculative defensive code.
Their pins and telemetry meet the removal requirements in
[`engineering-invariants.md`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/docs/engineering-invariants.md).

## Fragmented facet lifecycle

One facet name uses all of the following durable row families:

| Key                           | Meaning                    | Primary site                                                                                                                                |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `facet:<name>`                | startup spec               | [`facet-host.ts:1351`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:1351) |
| `facet:<name>:loader-id`      | last started identity      | [`facet-host.ts:1114`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:1114) |
| `facet:<name>:named-worker`   | published generation       | [`facet-host.ts:1229`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:1229) |
| `facet:<name>:restarts`       | loader-heal count          | [`facet-host.ts:351`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:351)   |
| `facet-ran:<name>`            | needs birth/sweep handling | [`facet-host.ts:605`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:605)   |
| `facet-claim:<name>`          | durable revive lease       | [`facet-host.ts:622`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:622)   |
| `facet-claim-failures:<name>` | durable revive ladder      | [`facet-host.ts:612`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:612)   |

The same facts are duplicated in `#facetClaims`, `#facetReviveFailures`,
`#loaderIdByName`, `#namedWorkerInstalled`, `#ranThisIncarnation`,
`#facetGenerationByName`, `#liveFacetNames`, and recovery/result caches
([`facet-host.ts:246`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:246)). This is the principal source of interleaving complexity.

### Candidate design

Use one validated durable record per facet and one explicitly ephemeral runtime
record:

```ts
type FacetLifecycle = {
  spec?: FacetSpec;
  installed?: { loaderId: string; namedWorker?: NamedWorkerStarted };
  ranSinceStart?: boolean;
  claim?: { at: number; cause?: Cause; failures: number };
  loaderRecoveryCount?: number;
};

type FacetRuntime = {
  generation: number;
  live: boolean;
  recovery?: Promise<void>;
  publicMethodsByLoaderId: Map<string, readonly string[]>;
};
```

`FacetLifecycle` is loaded once and written at the end of one named transition.
`FacetRuntime` is never reconstructed from storage; it only prevents a late call
from changing a newer incarnation's facet. A single `transition(name, reason,
{ restart })` owns the `blockConcurrencyWhile` stop/start pair and all durable
updates. Claims mutate `lifecycle.claim`; birth and quiet selection filter the
same records rather than scanning different key prefixes.

This removes constructor prefix scans and repeated KV casts at
[`facet-host.ts:307`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:307), and turns deletion from eight independent mutations
([`facet-host.ts:1442`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:1442)) into one lifecycle deletion.

The replacement must retain these invariants:

1. No parent commit between abort and startup attempt.
2. A durable claim is spent before `revive`, and the facet supplies its next
   claim: [`facet-host.ts:373`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:373).
3. `ranSinceStart` is cleared only after successful reset/start; failed starts
   stay eligible: [`facet-host.ts:460`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:460), [`facet-host.ts:490`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:490).
4. Late calls cannot stop or persist over their replacement.
5. Published workers only move forward: [`facet-host.ts:1199`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:1199).

## Concrete bug: divergent loader failure classification

Facets classify a loader fault with `isFacetStartPlatformFailure` at
[`facet-host.ts:86`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:86). Stateless workers use the stricter `isLoadedWorkerPlatformFailure` at
[`worker-loader.ts:449`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:449). The latter excludes coded, overloaded, and `remote` errors; the facet predicate only excludes coded errors.

Therefore a loaded facet whose own code throws
`Object.assign(new Error("internal error; reference = x"), { remote: true })`
is misclassified by the facet path as a platform start fault and restarted. The
worker path correctly treats the exact look-alike as user code; see
[`worker-loader.test.ts:551`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.test.ts:551).

Export one shared classifier from `worker-loader.ts` and use it in both paths.
Keep call policy separate: both paths retire an actually bad identity; only an
idempotent operation may replay. Add a facet-host regression row asserting no
restart for the remote error. This is a capability-preserving bug fix.

## Split the loader by responsibility

`prepareConfinedWorker` currently combines source resolution, producer KV
memoization, cache-key construction, poisoned-entry recovery, and confined code
construction across [`worker-loader.ts:248`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:248)-[`worker-loader.ts:436`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:436).

Split it into:

1. `resolveSource(spec)` for literal/producer resolution, producer KV, and the
   one idempotent producer retry;
2. `loaderKey(context, identity)` for deploy/origin/owner identity;
3. `loadGeneration(key, resolve)` for the poisoned-entry workaround;
4. `confinedCode(resolved, itxEntrypoint)` for the Worker Loader payload.

Facets and `workers.get` can then share `loadGeneration` and its classifier,
while retaining different retry permission. Keep the JSON-array key and every
one of owner, deploy ID, platform origin, and generation suffix: these protect
against host-stub reuse or authority sharing, as documented at
[`worker-loader.ts:341`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:341).

Literal modules are currently addressed by two non-cryptographic 32-bit hashes
and length ([`worker-loader.ts:158`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:158)). The comment calls this an accidental-collision guard under a trusted-client
assumption. A collision causes stale code for an owner, not an established
cross-owner exploit because owner remains keyed. Still, sources arrive through
capabilities, so use awaited SHA-256 in the asynchronous loader path; the code
already has `sha256Hex` for producer KV identity at
[`worker-loader.ts:305`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/worker-loader.ts:305). This is a local design hardening, not a claimed platform defect.

## Alarm and residency

The one-alarm architecture is already the right core shape. The coordinator
computes the earliest deadline without keeping a second durable schedule
([`alarm-coordinator.ts:143`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/alarm-coordinator.ts:143)). The parent combines durable schedules, subscription cursors, facet claims,
an in-memory quiet sweep, and in-memory owed runs at
[`iterate-context-durable-object.ts:1240`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/iterate-context-durable-object.ts:1240).

Give every input a small shared interface:

```ts
interface AlarmSource {
  nextDeadline(): number | null;
  runDue(now: number): Promise<void>;
  durable: boolean;
}
```

Use an ordered array of schedule, subscription, facet-lease, and quiet-facet
sources. Preserve current ordering, particularly quiet-facet first. Keep the
overdue watch outside this abstraction; it guards native alarm delivery, not
product work.

## Scale risk: unbounded reset fan-out

Birth and quiet reset collect all previously-run facets and run all starts with
`Promise.all` inside `blockConcurrencyWhile` ([`facet-host.ts:460`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:460), [`facet-host.ts:531`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/src/context/facet-host.ts:531)). Each start has a watchdog, but the batch has no cardinality or concurrency bound. Many configured facets can therefore turn one rebirth/sweep into an unbounded set of producer resolutions while normal parent work is blocked.

The platform defect requires immediate startup after each abort, not parallel
startup of every facet. Start a bounded batch or persist a lifecycle cursor; do
not abort the next child until the prior child's startup attempt is established.
Log batch count, duration, and pending names. Add a stress worker test that
proves no individual abort/start pair admits a parent commit and failed starts
remain eligible for the next pass.

## Tests: what can shrink

The directly related unit, Workers, and deployed suites contain 5,609 lines.
They are not interchangeable: unit tests model deterministic deadlines;
Workers tests exercise workerd containers and sessions; deployed slow tests
verify Cloudflare eviction and the raw storage fault. The distinction is
documented at [`residency.md:119`](/Users/jonastemplestein/.herdr/worktrees/iterate/iterate/core-simplification/apps/os/docs/residency.md:119).

Keep the raw deployed `createFailing` fault pin and production telemetry pins.
After `FacetLifecycle` is introduced, delete tests that only assert individual
private key spellings, mirror synchronization, or a particular `Map` update.
Replace them with a compact lifecycle table:

`unconfigured -> configured -> running -> leased | unclaimed -> stopped -> starting`.

Retain rows that change observable behaviour: lease recovery, source change,
late old-generation call, timeout, deletion, and each documented platform
failure.

## Safe implementation order

1. Share the loader-failure classifier and add the remote-error facet regression.
2. Add `FacetLifecycle` behind a read adapter for existing rows; preview and
   inspect lifecycle state and telemetry.
3. Move claim, birth/sweep selection, recovery count, and deletion to that
   record; then remove old rows and mechanics-only tests.
4. Extract loader resolution, identity, generation, and confinement without
   changing current loader IDs; assert equivalence on existing fixtures.
5. Introduce the alarm-source interface without changing pass order; run slow
   residency rows and the deployed raw-fault pin.
