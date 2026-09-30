# Cook the context kernel back down

**Status: draft finding report, 30 September 2026.** This is a breaking
proof-of-concept recommendation, tracked in draft PR
[#3451](https://github.com/iterate/iterate/pull/3451). The audit baseline is
`cfd8a1d3687c77755817d6c5ece586bc15a24bf6`; the later validation baseline is
`ce251e06c1c3c5894aebdc674e57b2196be0ae08` after #3442. Main observed at
00:00 UTC on 30 September is `b6c8c7009`, including #3447's birth/configuration
move, #3448's caller-supplied deployment, Docs, and #3455's RPC response-stream
fix. Main subsequently reached `e9f059e8c` with #3460.

## Latest published checkpoint

Source draft [#3461](https://github.com/iterate/iterate/pull/3461) is published
at immutable `5eff1bf859f710c714806d84c8a33f3fcd397048`. It is a tested source
checkpoint, not release proof. The prior private `subscriptions` facet was an
intermediate experiment and is not a claimed net deletion from main; durable
delivery now belongs in the context alongside the log, cursor, target authority,
and recovery wake.

The frozen `5eff` full root run is green: OS reports 154 passing files, 2,314
passing tests, and 14 existing expected failures; 51 SDK suites and full
typecheck, lint, formatting, and Knip also pass. Its runtime count is 18,081
core lines plus 7,497 SDK lines, or 25,578 combined: 42 below the 25,620 main
baseline. That is the current comparison, not the agent-stat count that includes
tests. Tests and moved code are never credited as runtime deletions.

External evidence remains incomplete. Preview, performance, 100-run soak, and
log comparison for `5eff` remain pending. Its predecessor `8d` had all 11
browser checks green and 326 E2E passes; three stale fixtures were repaired
before the `5eff` run. Those predecessor results do not replace the required
`5eff` external validation.

The remaining architecture keeps the existing pager for live providers and
callbacks. The context owns durable delivery's log, cursor, resume
acknowledgement, native target authority, and recovery wake. Fan-out persists
one eight-call wave and its combined outcomes; ephemerals use their bounded
live path. Processor authoring, React integration, ordinary facets, and vanilla
Cap'n Web remain unchanged.

Concrete requirement relaxations implemented in the second PR are fixed-prefix
names plus ordinary adapter code, explicit configured origin and delivery,
one 25-attempt/four-hour-capped durable retry policy, bounded recovery on the
context wake, and explicit opt-in to delivery failure receipts. They remove
separate configuration languages, target inspection and reconstructed wake
state without reducing available capabilities. The much larger potential cut
is to make consumers own their durable forwarding policy as ordinary processors;
that changes a platform guarantee and is still a proposal, not a current deletion.

The history below retains each earlier checkpoint and its failures rather than
presenting old green performance or cancelled soak work as evidence for this head.

The first full-access Workers run started from a built working tree at
`30875b8b9`. It completed: 2,284 tests passed, 14 were expected failures, and
22 failed. The failures are source outcomes, not the earlier sandbox
loopback/Wrangler `EPERM` startup problem. Follow-up edits are in the same
working tree, so `30875b8b9` is provenance for that run rather than an
immutable final candidate. A later focused Workers run had 83 passing tests,
6 expected failures, and 12 failures. Neither run is release evidence; the
candidate remains unmerged and under repair.

The measurements below use immutable revisions where stated; they are not
final candidate counts. Implementation is a separate, unmerged effort.

The core does not need a large new type system to become simpler. It needs a
smaller answer to one question: what is an Iterate context?

A context is an event log and an `itx` namespace of ordinary Cap'n Web
capabilities. It can append, read, wait, subscribe, invoke, fetch, and `cd` to
another context. A jail is an explicit inheritance boundary. Capabilities are
ordinary objects; agents, voice, Garple policy, webhook policy, and integration
logic are ordinary code above the context.

```ts
await itx.append({
  type: "tasks.example.com/task-created",
  payload: { id: "task-1" },
});

const task = await itx.tasks.get("task-1");
const child = itx.cd("/visitor");
```

That is the active recommendation. It keeps the words and the client shape
that already exist: `itx`, `append`, `readEvents`, `provide`, `subscribe`,
`invoke`, `cd`, processor, and facet. The proof of concept may break durable
row shapes and overloaded subscription behaviour; it should not invent a
second vocabulary without a semantic reason.

## The small model

### Ordinary capabilities and an explicit jail

Today `provide` attaches a live Cap'n Web stub or writes a durable rewrite row;
`cd` addresses a child; `append` records durable context facts. The core should
retain those verbs and make their simple meaning easier to see. A capability is
named in the `itx` namespace and invoked as normal Cap'n Web RPC. A local name
wins; otherwise the context may inherit through its parent. A jailed context
does not inherit until a permitted capability is explicitly provided.

```ts
// Existing live-provider spelling: the handle recalls the provider at disposal.
using camera = await itx.provide(["itx", "clients", "camera"], cameraStub, {
  description: "The connected camera for this context.",
});

// Existing address and invocation spelling.
await itx.cd("/visitor").invoke(["itx", "catalog", "search"], "lamp");
```

The resolver may cache an inherited surface for latency. A parent change or a
jail change still needs the existing revision fence before a cached call is
admitted. That fence is implementation below `cd`, not a JavaScript prototype
API and not a new expression language.

There are three distinct things here:

- A **live capability** is a current RPC object, such as a browser, tunnel, or
  connected client. It is held by the pager/session, borrowed for a call, and
  released afterwards.
- A **durable recipe** is owner-controlled state that can recreate a capability
  when its owner supports restoration. It is not transparent serialization of
  a live Cap'n Web reference.
- A **description** is documentation. The existing `provide` description and
  `rewriteRules.list()` projection are the right shape. If type information is
  added, use one optional TypeScript declaration string on that same record;
  absent means unknown. Do not add a schema engine or runtime reflection.

Do not persist live references or secret values as context state. Cap'n Web
targets and TypeScript types do not provide general durable reflection. A
short, author-supplied description is more honest and more useful to people
and language models than a descriptor framework that claims to know every
method at runtime.

### Private factories, not public capability kinds

Trusted/untrusted and stateful/stateless describe how platform code constructs
a capability. They do not describe what a caller sees in `itx`, and they should
not become a public tagged union stored with every capability.

The existing private `buildBuiltIns(deps)` factory is the appropriate place to
choose whether a capability is backed by a Worker Entrypoint or a Durable
Object/facet and which bindings a trusted implementation receives (for example
`env.AI`). An untrusted Worker or facet receives only its `itx` facade. Project
and global contexts differ because their factories assemble different objects.
This is the useful meaning of `ITX.Builtins`: privileged construction code,
not a public universal object or an extensible policy taxonomy.

The current implementation slice has already removed the public
`TrustedBuiltInCapability` taxonomy and metadata-only availability projection.
The remaining private data is the existing root names, descriptions, and two
root sets. Physical types reuse `IterateContextApi` plus the platform-only
overrides. This does not introduce a descriptor or factory schema.

### Subscribe through ordinary RPC; repair durable work from the log

`provide` and live `subscribe` already lend their session-bound targets through
the same pager/relay mechanism. Keep that mechanism. A committed batch reaches
a current subscriber through ordinary RPC. The pager carries the notification
when the target is live. A durable consumer treats the notification range as a
hint and reads from its own checkpoint; an ephemeral event exists only in the
current notification.

This keeps low latency without asking the context to preserve a live browser
callback. It also avoids a false distinction between a provider transport and a
subscription transport: both use the same borrow/page/release/redial path.
The provider call lease remains bounded. Expiry releases the caller's borrowed
invocation; it does not cancel arbitrary provider-side work or a returned
streaming body.

## Near-term simplification: durable names and live `provide`

The next source slice is smaller than the earlier delivery rewrite. A durable
configured name becomes one simple mapping: an absolute context address plus a
fixed list of `invoke` steps. A jail is the one parent entry that refuses
fallback. Fixed steps preserve current facet and webhook paths with calls in the
middle, while removing holes, argument-prefix matching, and repeated rewrite
rules. This is an internal representation behind existing `itx`, `cd`, and
`invoke` spelling, not a new public target-kind framework.

Live `provide` becomes a pager attachment, carrying its name, optional fetch
route, description, and declaration. Attaching and detaching a live stub writes
no durable rule event. A live attachment shadows a durable name while connected;
when it detaches, the durable name becomes visible again. This removes the
current bug where detaching a live `provide` can remove the durable name it
shadowed. Session-scoped expression and null provisions remain convenience
wrappers around the ordinary rule event.

The third independent Opus review estimates roughly 530 net product lines
removed after the new lookup, temporary offer overlay, snapshot epoch, and
reattach wake hook are added. It identifies deletable pieces: offer census,
rule-based provider cleanup, live subscription rule branches,
hole/pinned-prefix rewrite handling, reduce-time
target re-resolution, and the no-op platform birth hook. This is a review
estimate for the proposed source slice, not a committed deletion or a whole
repository line-count claim.

The implementation is now testing durable cursor/retry delivery in an SDK
processor hosted by a private facet. The old broker can be removed only when
its outcomes have equal-or-higher-fidelity replacement coverage, including
config birth delivery authority, batching, wake, halt/resume, and fan-out.
Breaking state is permitted; losing these capabilities is not. The focused
evidence below does not yet establish that replacement.

The review caught a proof-of-concept state incompatibility: making `delivery`
required while leaving `CoreContract` at `17.0.0` silently skipped existing
birth subscriptions. The active source direction is `18.0.0` with an explicit
context-recreation refusal for rows without a delivery contract. It does not
migrate existing logs. Backward compatibility is not required, but silently
stopping config-worker delivery is unacceptable.

### Round 4 checkpoint: what is now covered, and what remains open

[The fourth independent Opus review](reviews/opus-implementation-round-4.md)
was performed against a moving implementation checkpoint. It said not to merge
or deploy that checkpoint. The table below records later source evidence.
Focused source runs reported by their owners are named exactly; they are useful
but do not replace the source PR’s eventual required checks, soak, or preview
telemetry.

| Round-4 concern                                                                                          | Later source evidence                                                                                                                                                                                                                                                                                                                                   | Status for this findings PR                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A replay of a delivery-less pre-v18 subscription silently drops a config or processor row                | `core-processor.test.ts` covers a pre-delivery row being rejected/reported; `stream.test.ts` covers a pre-v18 checkpoint refusing the next context operation. The stream constructor has a whole-context removed-shape gate rather than accepting an individual skipped row. Owners report the stream/core focused run **132/132 passing**.             | **Focused test passing.** Fresh state/recreation is an explicit breaking prerequisite; source-PR CI remains required.                       |
| A loaded-code `provide(stub)` or callback leaves a durable offline shadow after its pager disconnects    | The active source has an ephemeral live overlay and comments that detach reveals the durable row underneath. Existing pager attach/reset/hibernate tests remain relevant, but the pager suite is being rewritten and only **4/17** obsolete assertions currently pass.                                                                                  | **Open.** Do not call lifecycle cleanup green before its replacement tests and source-PR CI pass.                                           |
| A live attachment can shadow a platform or jailed name without the normal admission and revocation fence | `validateLivePagerRows()` applies loaded-code admission before opening a pager, and the durable object has a snapshot-wait path for attachment replacement. Owners report the warmed child live-shadow fence test **1/1 passing**, and the jailed ordinary-adapter test **1/1 passing** with real confined-worker denial of `fetch`, secrets, and `cd`. | **Partly proven.** A member shadowing platform configuration and the complete stale-snapshot/lifecycle matrix still need explicit coverage. |
| The SDK durable-delivery runner can replace core delivery                                                | The runner has pending-range-before-call, stable keys, bounded fan-out, and no emitted success event. One new durable-facet Workers happy test for ordered/fan-out delivery passes. A later independent review found fan-out exhaustion incorrectly halts the whole row; owners are fixing it.                                                          | **Open.** It remains unsuitable as a reason to delete the core delivery path.                                                               |
| The new fixed-step mapping has an ordering/argument semantic bug for fresh rows                          | Round 4’s source review found no fresh-row defect: fixed calls precede caller arguments, a final call can return the value invoked by caller arguments, trailing steps remain, and longest property match is total. Owners report the rewrite focused run **147/147 passing**.                                                                          | **Focused test passing.** Retained-state compatibility is separately refused.                                                               |

This table deliberately does not claim a line reduction, runtime parity, or
soak result for the in-progress delivery work. It is an audit ledger, not a
merge decision.

### Round 5 delivery checkpoint: focused evidence is not release evidence

[The fifth independent Opus review](reviews/opus-durable-delivery-round-5.md)
was a no-go review of an in-flight snapshot. It found eight blockers spanning
bundle loading, terminal receipts, omitted `consumes`, halted-runner resume,
facet authority, live attachment admission, ephemeral delivery, and legacy
state refusal. Later work has resolved parts of that snapshot, but the source
PR remains blocked until the whole set is retested and independently reviewed.

| Item                                                | Latest confirmed evidence                                                                                                                                                                      | Ledger status                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Default `consumes` and terminal receipt append path | Owners report the original/full SDK focused suite **312/312 passing** and the runner/model suite **14/14 passing** after fixing default-all consumption and the terminal `Stream.append` path. | **Focused tests passing.** This does not establish end-to-end parity.                                            |
| Ordinary live core behaviour                        | Owners report the focused live-core run **10/10 passing**.                                                                                                                                     | **Focused tests passing.**                                                                                       |
| Preview-log utility                                 | Owners report its focused suite **3/3 passing**.                                                                                                                                               | **Focused tests passing.** It is evidence tooling, not runtime parity.                                           |
| Pager lifecycle and attachment security             | The pager suite reached **17/18**; the remaining security test was corrected and passes alone **1/1**. The complete pager suite has not yet been rerun after that correction.                  | **Open.** Do not call pager coverage green from the isolated security result.                                    |
| Durable Object integration and legacy refusal       | Owners report the focused DO run **12/12 passing**, but expected legacy-state refusal still produces an unhandled native rejection that is being fixed.                                        | **Open.** A correct refusal must leave normal lifecycle operations, including recreation, observable and usable. |
| Durable alias ending at a processor method          | The alias is now routed through the actual processor target’s authority fixed point; Workers validation remains outstanding.                                                                   | **Open until Workers coverage passes.** A durable alias must not gain platform-only facet authority.             |
| Fan-out exhaustion and resume                       | The SDK/model correction is passing, but it has not yet been demonstrated through the actual Worker deployment.                                                                                | **Open.** No core-delivery deletion or parity claim is justified.                                                |

### Round 6: infrastructure must not resolve through a user rule

[The sixth independent Opus review](reviews/opus-private-bridge-round-6.md)
conditionally accepts passing an admitted page directly from the private
subscriptions host to the context Durable Object. Its condition is simple:
`subscriptions` must be reserved from ordinary processor/facet operations, and
its read, claim, and delivery calls must use the context Durable Object’s
private channel. They must not be ordinary `itx` expressions that a project can
rewrite, provide, mask, or jail.

This removes difficult states rather than adding a public abstraction. A user
rule can no longer return a fabricated source page or advance a claim; disabling
or aborting `subscriptions` cannot discard its cursor; a reconfigured, resumed,
or halted row cannot invoke a stale target when the current-row check happens
both before resolution and immediately before invocation; and a retry cannot
overlap a still-running target when the context keeps one private in-flight
entry for that row generation and resume state. Shared memory reservations must
cover reads before materialization and retain target bodies until the original
call settles: a deadline does not cancel native RPC work. Exact memory and
cross-row throughput proofs are still required. These are implementation
constraints below `subscribe`, `provide`, and
processors, not a new capability kind or user-facing API.

The direct handoff is not a generic privilege grant. It carries the named row,
its configured/resume offsets, range, and one bounded page; the context checks
that page’s order, range, event filter, durable/ephemeral rule, and current row
before invoking the ordinary target. A retry reads the persisted range through
the same private context channel. The review’s required Workers coverage,
races, hung-target behaviour, and latency measurements remain prerequisites.

### Round 7: the context owns a delivery body until its target settles

[The seventh independent Opus review](reviews/opus-direct-private-delivery-round-7.md)
accepts the direct private handoff direction, subject to focused proof. A
provider deadline ends the facet’s wait; it does not cancel a native target
call. The context therefore keeps the body reservation until that original call
settles. A busy row or an exhausted reservation is retryable work, not a failed
delivery attempt; a late success must be observed rather than retried.

The review also requires the existing names and boundaries to hold: one active
entry for an ordered row or a fan-out event, current resume data passed with
each delivery rather than captured by a stale runner, the reserved
`subscriptions` facet refused from raw configuration and ordinary facet
operations, and one private claim helper shared with the existing processor
lifecycle. It does not introduce a new public protocol.

Two memory checks pass, but a test with 19 waiters behind one full page exposed
head-of-line blocking. Treat memory and throughput as open: no performance
result is claimed from those checks.

### Round 8: durable bodies stay in the context

[The eighth independent Opus review](reviews/opus-durable-bodies-round-8.md)
agrees with the other independent reviews: durable event bodies stay in the
context. The private `subscriptions` facet keeps only cursor/range or selected
offsets. For a durable attempt, the context rereads the bounded range, filters
under the current row, owns the one active target-body ledger, resolves and
invokes the ordinary target, and releases bytes only when that call settles.

The resumed source candidate implements that recommendation. It removes
full-page facet leases, waiters, and durable-body round trips; ephemeral bodies
remain on their separate one-event path
because they cannot be reread. The required proof includes a large slow target
beside small rows, overlapping fan-out, retry without metadata rereads,
resume/replacement races, bounded ledger telemetry, and no durable work for an
ephemeral-only commit.

The later source checkpoint `abbdec539` derives subscriptions configuration
from current core state on revive, removes the duplicate facet configuration
cache, and invalidates disposed runner generations. Root typecheck and non-OS
tests passed at that checkpoint. The resumed candidate additionally fences
delayed configuration snapshots, preserves wakes after runner disposal, and
continues fan-out admission beyond a single page. These are implementation
changes with focused unit and TypeScript checks, not deployed performance
evidence. A restored-full-access Workers run has now completed, so the remaining
runtime failures below are real candidate failures rather than startup or
sandbox evidence. Runtime parity, preview latency, soak, and Cloudflare Logs
remain required after the source repair is complete.

### Post-round-8 source review: the remaining ownership details

A read-only source review of the current dirty candidate followed round 8. The
attempted ninth independent Claude call produced no model output because its
CLI was logged out and the pool was locked; this supplement is therefore not
attributed to Claude or counted as an independent review.

The source retains selected durable bodies only in the context's active ledger
until the raw target settles. It uses one synchronous scratch source page to
reconstruct and check those bodies, then releases that page before an await.
There is no full-page waiter queue or global gate. The private facet continues
to hold only offsets, ranges, cursor progress, retry state, and bounded
one-event ephemerals.

The follow-up source changes address the review's concrete races: a cold facet
fetches current native configuration before accepting its first supplied push;
an equal configuration offset carries ephemeral work without another KV write;
a terminal receipt advances the runner generation before an older call can
write local state; and fan-out continues across pages while there is pending
capacity. These are source properties and focused test targets. Workers,
latency, throughput, and soak evidence remain required.

### #3460 guarantees retained by the source rewrite

The final local checkpoint of this resumed turn is `30875b8b9`. It also fixes a
retry-cache defect: a settled target failure was replayed for 40 seconds under
the same source-range key, spending attempts without actually retrying the
target. Only successful late calls are now cached. An ordinary failure leaves
the next bounded retry free to invoke again; this needs no acknowledgement
protocol or attempt taxonomy. The focused runner/model suite passes 27 tests,
and full lint, typecheck, formatting, Knip and the OS build pass.

The full root Workers run from this checkpoint completed under full access:
22 failures, 2,284 passes, and 14 expected failures. Later focused repairs
also ran under full access and still had 12 failures. Two stale public-placement
assertions were corrected to cover the reserved private facet, but they do not
turn either run into release evidence. A fresh complete Workers run is required
once the in-flight fixes settle.

Pinned counts are in
[`latest-main.tsv`](measurements/latest-main.tsv) and
[`offset-only-checkpoint.tsv`](measurements/offset-only-checkpoint.tsv). Against
`e9f059e8c`, narrow core runtime falls from 18,806 to 18,280 lines, while SDK
runtime rises from 6,814 to 7,563. Combined runtime therefore **grows by 223
lines**. All OS runtime falls by 700 lines. These counts include the private
delivery host and SDK additions: this is an ownership and authority
simplification, not the requested overall reduction to 15–20 thousand lines.
The recommendation must not count relocated code as deleted code.

Main commit `e9f059e8c` fixed stale subscription writes after replacement,
reconfiguration while a call is out, and excessive retained cause pages. The
rewrite must retain their outcomes: a call that outlives its row cannot write
an acknowledgement, route, memo, or fan-out state into its replacement; body
memory is bounded across rows; and platform infrastructure does not resolve
through owner-writable roots. Its fixed-point resolution is relevant to the
queued alias-to-processor Workers proof.

#3460 also preserves per-run facet end state. Keep that behaviour rather than
replacing it with a compact lifecycle record. Its former live census rows are
not carried forward because live attachment rows are no longer durable, not
because the live pager lifecycle has been dropped. Old cursor/fan-out tests
need named equal-or-higher-fidelity replacements; the ordered-to-fan-out
mid-call Workers proof remains queued.

React event-log/live-state hooks keep their current callback and gap-repair
behaviour. The vanilla Iterate Cap'n Web client remains a vanilla Cap'n Web
client.

### Comparison with the persisted simplification sweep

A separate persisted sweep plan was read as a design comparison, not as a live
Herder status check or an expanded implementation assignment. Its red-first
subscription fixes overlap #3460: exact row identity after replacement,
bounded retained cause pages, and fixed-point resolution through the platform
path. Those outcomes are now part of main and must survive the rewrite.

The sweep also proposes deliberate cuts outside this delivery slice. Making the
OS origin mandatory, consolidating ControlPlane/D1 failure boundaries, moving
integration recovery forward, and client-only cleanup may be worthwhile
separate changes. They are not evidence that this PR has removed their code or
validated their new requirements. Its proposal that cursor rows receive durable
events only is likewise a real behaviour change: it would remove best-effort
cursor delivery of ephemerals and needs an explicit consumer audit. It is not
claimed by the current candidate.

The shared architectural direction is narrower: keep body ownership in the
context and use the trusted native channel for platform work, while ordinary
user targets continue through `itx`. The source checkpoint under review was
`abbdec539` when this comparison was written; subsequent working-tree changes
and validation are recorded below. No performance or throughput result follows
from that comparison.

### Round 9: full-access failures and a second delivery audit

[The ninth independent review](reviews/opus-root-round-9.md) read the
mutable source tree beginning at `30875b8b9`. It used Claude Opus 5.5 with xhigh thinking:
68,047 thinking tokens, 78,635 output tokens, and 797,074 ms of model duration.
It did not run tests and could not find the Workers-level tests, so it is
source analysis rather than a validation result. The model began with the
`30875b8b9` checkpoint, and source repair continued during its request. It is
not an immutable review of a final commit.

The full-access root run establishes a useful boundary. The 22 failures include
config birth delivery not settling, denied fan-out targets not reaching their
terminal outcome, a forged relay failure not becoming observable, fan-out
progress and replacement failures, wake and webhook-halt failures, and a
number of unrelated baseline regressions. The later focused run still has 12
failures: birth rows, fan-out target refusal, stale configuration/claim
recovery, fan-out completion, wake causes, and webhook 410 halt are still in
that set. Those grouped names are not a claim that every timeout has one cause;
they are the failing observed outcomes that must be explained before release.

Several concrete delivery faults were found while repairing and reviewing that
source. They should be treated as fixes in progress until a fresh complete run
passes.

- Fan-out could leave the first completed batch in its pending cursor, so the
  next batch was never admitted. The first eight calls could overlap while the
  sixteen-call completion test timed out. The repair must persist the removed
  pending items before admitting more work.
- A settled-failure cache keyed only by row, resume marker, and source range
  replayed one real target error for forty seconds. Each retry spent an attempt
  without calling the target again. The cache has been narrowed to late
  successes only; a flaky target must have a Workers regression proving its
  second same-range attempt invokes it.
- A manual core halt could race an old local attempt. The old attempt received
  `GONE` and could publish a new attempt-one terminal view over the core's
  attempt-fifteen halt. The runner now needs to adopt the core receipt and
  advance its generation before older work can write state. The original
  ordered halt/resume assertion remains a required regression, not an obsolete
  expectation.
- A retry for a still-active row could reread and reconstruct the durable
  source page before discovering that the raw target call was already in
  flight. A same-row busy check belongs before that reread; it removes needless
  scratch-page work without restoring a global full-page gate.

The body-local design remains the preferred simplification. The subscriptions
facet carries selected offsets, ranges, retry state, and bounded ephemeral
work. The context rereads durable events, verifies the selection under the
current row, and holds selected bodies through the real target call. A durable
body therefore never crosses the private facet boundary. An ephemeral body
continues to use its one-event ring-validated path because it cannot be read
back from the log. This removes facet page leases, full-page transfer, and
body-accounting duplication while retaining the existing caller, jail,
fixed-point resolution, platform processor route, and row-generation fences.

The review identifies four small decisions that affect whether this remains a
simple, bounded implementation:

1. **Fan-out admission must continue past a backoff item.** If capacity remains
   and the prior page was not at the head, read another page before scheduling
   the backoff wake. Otherwise one failing event can hold a catch-up behind its
   retry cap. This is a local loop condition, not a new delivery mechanism.
2. **Busy work needs a bounded observable policy.** A target that never settles
   must not create a one-second claim/alarm loop forever. Waiting for an active
   call would spend attempts; retaining no-attempt busy retries requires a
   backoff and a terminal/recovery limit. The current direction keeps ordinary
   retry semantics and success-only late-result deduplication. It must expose
   consecutive busy time and count and prove the selected behaviour.
3. **A legal large page must make progress while idle.** The old admission test
   accepted an over-8 MiB selection only when it contained one event. Two legal
   roughly-4 MiB events can exceed the context envelope budget together and
   otherwise stay busy forever. The small relaxation is to admit any one idle
   request within the existing 32 MiB RPC ceiling, while retaining the normal
   8 MiB aggregate bound during concurrent calls.
4. **Ephemeral ordering and capacity remain deliberate limits.** The review
   found a possible lower-offset ephemeral being delivered after a later durable
   range and a single backlogged row monopolising facet ephemeral capacity.
   Sending only ephemeral offsets would remove the facet body queue, but it
   changes the ring and ordering contract. It is an option to test, not an
   accepted deletion.

The review also calls out stale cursor-key cleanup, resume-with-seek behaviour
on a live row, equal configuration snapshots, duplicate push/claim work, and
release-versus-pre-push-claim ordering. These are good deletion targets only
where a native configuration pull or existing claim lifecycle gives the same
recovery outcome. Removing the stored configuration copy is justified because
core state is authoritative; removing the only durable recovery claim is not.

The review confirmed several constraints that keep the design safe: row,
resume, and halt fences before and after awaits; one active call per ordered row
or fan-out offset; body release only when the raw target settles; terminal
idempotency including the resume identity; and no cursor for ephemeral events.
They remain required evidence, not reasons to relax the tests.

### Full-access publication checkpoint

Source `9c48a4a6f4314093c343f7851807b0afb033b1d7`, based on unchanged main
`e9f059e8c`, passes the full local root test command. OS reports 2,311 passing
tests and 14 expected failures across 151 passing files; all other package
suites also pass, including socket-dependent suites. Full lint, typecheck,
formatting, Knip and build pass. No socket tests were deleted to obtain green.

This proves the local checkpoint, not the final design or a deployment.
The confirmed fixes include fan-out persistence and row halt/resume, ephemeral
JSON equality, corrupt-row reconstruction, new-name live attachment latency,
captured claim release, cold retry recovery and obsolete placement fixtures.
Attempts are persisted before target results, so recovery tests now wait for
actual retry errors and forwarded deadlines before restarting the facet.

The checkpoint still grows combined core and SDK by **391 physical runtime
lines**: 18,399 core plus 7,612 SDK versus main's 18,806 plus 6,814. A passing
replacement is not enough to call it the requested simplification.

Two further experiments are isolated from that tested checkpoint. Requiring
configured `urls.os` removes request-derived origin, header and loader-cache
state. Hosting the existing trusted delivery runner beside the context log
could remove the private delivery facet, bridge and competing claim writers.
It preserves untrusted target workers/facets and public processor authoring;
only the placement of trusted cursor state changes. Neither experiment counts
as a deletion until its runtime parity is proven.

[The tenth actual Opus 5.5 xhigh review](reviews/opus-round-10.md) confirms the earlier fixes and finds
additional resume and private corrupt-read loops, ephemeral ordering and an
unbounded busy policy. Its proposed native promise join preserves single-flight
and at-least-once delivery; it cannot promise deduplication after a raw call has
settled between timeout and retry.

### Published preview 9c and round 11

The published `9c48a4a6f4314093c343f7851807b0afb033b1d7` checkpoint has a
real local root result: all packages passed; the OS suite had 151 passing files,
2,311 passing tests and 14 expected failures. This is a stronger local result than the earlier repair
runs, but it does not make the candidate final or make a later native design
green.

The deployed preview is not healthy enough to merge. Its E2E job recorded 19
failures in 9 files, alongside 311 passing tests, 9 expected failures, and 34
skips. The failures include durable cursor resume, ephemeral delivery range,
first-delivery error handling, live pager cleanup, and the old durable-route
assumption in the tunnel/example tests. They are a mixture of product
regressions and E2E expectations that now describe the wrong lifecycle, but
all need a specific source fix or corrected assertion and a rerun. The preview
browser suite is green: all 11 browser rows passed. That is useful surface
coverage, not a substitute for the failed RPC and delivery rows.

All 13 emitted latency budgets passed. Five residency rows were skipped by
that run's selection, so no residency conclusion follows from the latency
result. The 100-run soak was cancelled after its first deterministic repro; it
is not a completed soak result. Its early failures include the same
beyond-head cursor resume and ephemeral-range outcomes reported by E2E, so
cancelling preserved a reproducible failure instead of averaging it away.

A same-window preview-versus-main logs comparison found **14 additional error
records** and **134 additional platform-failure recovery records**. The latter
are mostly `lendRpcStub` recovery entries, with one context alarm re-arm. These
counts are telemetry signals, not a fault attribution: the error messages and
the repeated recoveries must be reduced or explained before deployment
approval. They rule out describing preview validation as clean.

[The eleventh independent review](reviews/opus-round-11.md) is promising as a
simplification direction, not as a final implementation decision. It proposes
hosting the trusted durable runner and its cursor beside the context log rather
than in the separate private `subscriptions` facet. That could delete the
facet, bridge RPCs, duplicated configuration pull/fence state, and the
cross-object body handoff. Public `itx`, ordinary target resolution, jail,
Cap'n Web authoring, and user processor/facet APIs would stay the same.

The review was a mutable-tree read: it inspected
`/private/tmp/iterate-core-simplification-resumed` at reported `ef90c40ba`,
not the supplied frozen review source, and could not verify that tree against
the manifest. It ran no tests. Its conclusion therefore does not establish a
native context-cursor implementation, line reduction, or release readiness.
The required conditions are concrete: an existing residency pin must keep a
real target call alive; each durable row needs a persisted owed mark for the
commit-to-admission gap; the raw call and its body reservation must survive the runner deadline; and no delivery write may precede facet
birth initialization. The native design must also prove bounded per-pass CPU,
subrequests, fan-out concurrency, eviction retry, old-facet deployment
handling, and the same ordered/ephemeral contract. The review also suggested
waiting indefinitely for a raw target. That part is rejected: retries remain
bounded, and a retry can join the outstanding promise without removing its
deadline or attempt limit.

This is the cleanest remaining relaxation because cursor ownership follows
log and target authority rather than creating another hosted object. It should
be rejected if those recovery and residency outcomes require rebuilding the
facet as a different keepalive or claim layer. The implementation draft
[#3461](https://github.com/iterate/iterate/pull/3461) is not ready to merge.

### Round 12: native cursor ownership has five release blockers

[The twelfth independent review](reviews/opus-round-12.md) read the immutable
`24f762f6b` native context-cursor experiment. It used Claude Opus 5.5 with
xhigh thinking: 79,184 thinking tokens, 87,930 output tokens, and 884,849 ms
of model duration. It found the ownership model simpler: the context now owns
the log, target authority, cursor, and alarm, and a terminal cursor update and
its terminal event can land in one synchronous turn. That is a real advantage
over a separate facet and bridge, but it is not a passing implementation.

The five blockers are source-backed rather than general cautions:

1. **Commit-to-admission recovery is only in memory.** A reset after a commit
   and before a pending cursor write can lose the only wake that would admit
   the event. Persist the existing-style recovery mark on the idle-to-active
   transition and restore it at birth.
2. **A reset during a target call can retry forever.** Attempts increment before
   the call, but the maximum was checked only in the catch path. A reset skips
   that path and can repeat every deadline. Check the persisted attempt before
   every call and take the normal terminal outcome at the existing bound.
3. **Construction writes an alarm too early.** Restoring wake state reconciles
   before the guarded birth rearm. That can leave an empty alarm pass and wake
   an orphan reached only by id. Let the existing post-birth callers reconcile
   instead.
4. **Cold fan-out lets one backoff hide ready work.** A long retry deadline can
   win over cold recovery even when unattempted items are waiting. Prefer the
   cold recovery wake so ready work starts promptly.
5. **The migration check misses an idle old facet.** Its marker is cleared after
   a clean birth, so an old durable row may look new and replay history. Refuse
   ownerless durable rows and do not write `deleteAlarm()` before facet birth.

These are small repairs, but they preserve guarantees the removed facet used to
supply: a durable recovery claim, a bounded death/restart path, and safe birth
ordering. The review also identifies cheap follow-on cuts: avoid deriving and
driving every row on every commit, reject exhausted body budget before reading
a page, and use the live ephemeral ring by offset rather than parsing a durable
body and comparing JSON. The reviewed source must still prove its residency,
CPU, subrequest, memory, fan-out, and old-data behaviour on Workers.

### Round 13: default fan-out delivery still has correctness and cost gaps

[The thirteenth independent review](reviews/opus-round-13.md) read immutable
source `179629660f` without making changes or running tests. It completed
successfully with Claude Opus 5.5 xhigh: 120,872 thinking tokens, 129,783 output
tokens, and 1,301,706 ms of model duration. It reports that Round 12's five
release blockers were repaired, but identifies further source-backed work on
the default project `config` fan-out row.

The material findings are: a selective fan-out resume can leave another
terminal item with an old resume marker and wake once per second forever; a
row that consumes everything can consume its own durable failed/halts facts;
and recovery can repeatedly arm an alarm in the past while a slow fan-out drain
is already running. The same review also identifies unnecessary cursor writes
for ephemerals below the durable head, delivery rereads that are not bounded by
the admitted range, source-selection errors that halt an entire fan-out row,
and retry policy captured only when a runner is created. These are concrete
repair and Workers-test requirements, not evidence that the architecture is
ready to merge.

The review's D8 storage conclusion needs a precise platform boundary. This
context is configured as a SQLite-backed Durable Object, for which Cloudflare
limits a key and its value together to 2 MB. The older 128 KiB value limit is
for legacy KV-backed Durable Objects and does not apply here.
[Cloudflare's limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
also measure the limit in bytes, while the current fan-out error truncation is
1,024 JavaScript string code units. One thousand ASCII snippets are about 1 MB
before cursor structure; non-Latin text can take materially more UTF-8 bytes.
Cloudflare does not document the exact serialized representation used for this
limit, so an asserted overflow at exactly 1,000 Unicode snippets would be
unsupported without a Workers probe. The supported conclusion is that the
cursor has no byte budget that can be compared to the platform limit. It may
violate that limit depending on serialization and its pending-item structure,
while rewriting the whole value per item is expensive even below the limit.

The safe repair is a byte-bounded cursor diagnostic, rather than a
character-bounded one: retain a short UTF-8-safe synopsis in each pending item
and preserve fuller bounded detail in the terminal fact or logs when that is
needed for operators. A 256-character cap reduces the likely footprint, but it
is not itself a byte guarantee and loses diagnostic detail unless the full
terminal record remains available. This does not change delivery semantics; it
changes how much failure text survives in the cursor. A Workers test must cover
1,000 pending entries with non-Latin errors, actual storage writes, and the
terminal diagnostic retained for inspection.

Cloudflare also documents a single alarm per Durable Object, at-least-once
alarm handling with automatic retries when the handler throws, and advises
scheduling alarms only when work is due because each invocation incurs cost.
Those facts support measuring and eliminating the reported past-due alarm loop;
they do not establish its frequency or CPU cost without the proposed fault
injection. See [Cloudflare alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/)
and [the Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

### Round 14: the generation proof permits real cuts, but cold recovery still loses rows

[The fourteenth independent review](reviews/opus-round-14.md) read immutable
source `7cdbc4f00944951f919fa6b0d0b26d32821ae94f`, made no changes, and ran no
tests. It completed successfully with Claude Opus 5.5 xhigh: 101,849 thinking
tokens, 107,666 output tokens, and 1,054,672 ms of model duration.

Its positive result is narrow and useful: every cursor writer other than the
single delivery drain advances the captured generation first. That proves a
late wave cannot clobber a later resume, halt, dispose, or reconciliation. The
proof makes several defensive cursor rereads and stamps redundant, so deleting
them is justified once the ordering that supplies the current resume remains
independent from effects that can throw. It does not prove that a runner has
already observed the core's current resume; the existing stale-resume fence
must remain until that ordering is made reliable.

The clear release verdict is still no. The review finds a cold request can
start only rows relevant to its first committed event, then clear the shared
wake while another row retains a backoff, interrupted attempt, or terminal
receipt. It also finds fan-out rows being driven by ephemerals they cannot
receive, empty fan-out admission rewriting a whole cursor, and terminal
receipts being emitted one alarm pass at a time while blocking new work. These
are source-backed P1/P2 defects. The review also reports stale ephemeral
descriptors after resume and halt receipts that often lose their source cause.
The per-item resume stamp defect from Round 13 was fixed after `7c`; that is a
separate repair and does not make the `7c` review's remaining P1/P2 findings
obsolete.

The review describes four concrete simplifications, each with a stated
relaxation:

1. **Append a terminal receipt in the same context-store turn and let the core
   row be the only halt state.** This could delete terminal-pending cursor
   state, its retry/wake pass, and related list fallbacks. It requires a
   synchronous terminal operation using the same store as the cursor. It is a
   promising major reduction, not an implemented replacement for the current
   generic SDK-hosted terminal path.
2. **Use the captured generation proof consistently.** Delete redundant
   rereads, pending checks, wave rereads, and terminal refinds after preserving
   the independent resume-order guarantee.
3. **Persist only a final interruption error.** This can reduce fan-out cursor
   payload by roughly tenfold, but a reset during the final attempt reports the
   generic interruption text instead of the previous target error. It changes
   diagnostics, not delivery behaviour.
4. **Use `confirmedOffset` as the sole fan-out admission mark.** This removes
   the wrapper and fallback constructions, with a cursor-shape migration cost
   limited to this branch.

The frozen `5eff` checkpoint repairs the review's P1 cold recovery by driving
all freshly reconciled non-halted rows, excludes fan-out rows from ephemeral
pushes, and skips empty fan-out admission writes. The SDK now uses one
`confirmedOffset` admission mark with a flat pending-item array rather than
per-item resume stamps; captured generations fence every writer, and resume
clears obsolete ephemeral descriptors. Selective resume retains its new seek
boundary, and the ordered and fan-out halt rows carry the selected source offset
for receipt causes. Five native fault probes cover those outcomes.

The checkpoint also accepts the diagnostic tradeoff in C narrowly: it retains
terminal errors while dropping transient per-attempt last errors. That should
not be represented as a universal tenfold cursor reduction while asynchronous
terminal errors remain stored. P2's one asynchronous terminal receipt per alarm
pass remains a known cost. A same-context synchronous receipt is still a
promising but unimplemented simplification. The review's remaining deletions
are candidates only until external `5eff` validation covers recovery, alarm
behaviour, fan-out terminal handling, and source-cause preservation.

## What remains core

Core owns the append-only durable log, bounded ephemerals, `itx` name
resolution with `cd` and jail, the live pager, fetch entry/exit, and minimal
Worker/facet activation. Fetch is a Request/Response adapter at the context
boundary, not a new kind of capability. Core does not own agent loops, voice
protocols, Garple sales policy, webhook retry policy, app configuration
languages, or a universal persistence mechanism for Cap'n Web references.

Cloudflare Durable Object, hibernation, alarm, Worker Loader, and facet
workarounds stay behind these implementation boundaries. They remain wherever
tests prove platform behaviour; they must not leak into the public context model
as a large target/descriptor/type taxonomy.

## Measured audit evidence and priorities

The reproducible narrow runtime count at the original `cfd8a1d368` audit is
**25,545 physical TypeScript/TSX lines**: 18,787 in the OS context runtime and
a 6,758 SDK upper bound. Broader OS runtime is 45,012 lines.

The later validation baseline `ce251e06c1` contains 18,845 kernel lines and
6,814 SDK lines. A source checkpoint at `1341cccea` contains 17,882 kernel
lines and 7,162 SDK lines, including the new private subscriptions facet.
Those checkpoints also include main's intervening changes, so subtracting
them is not the source PR's net change. Its final measurement must compare
its actual main base and tested head.

[`count-loc.sh`](count-loc.sh) accepts a pinned revision and includes the
private delivery host. The immutable outputs are recorded in
[`initial-audit.tsv`](measurements/initial-audit.tsv),
[`validation-baseline.tsv`](measurements/validation-baseline.tsv), and
[`source-checkpoint.tsv`](measurements/source-checkpoint.tsv). The dirty
source tree is not release evidence, and moving code into the SDK is not a
whole-product deletion.

All figures are physical lines, not a deletion promise.

Three root causes account for the most concentrated complexity.

1. Built-ins are described, routed, placed, and assembled in parallel lists.
   Keep the private physical routing data while collapsing duplicate factory
   wiring. Do not replace those lists with a public descriptor framework.
2. Live callbacks and subscriptions already share a pager, but durable generic
   delivery separately infers guarantees from an evaluated target. Separate the
   temporary live attachment from the durable name mapping; move durable
   progress only after proving its replacement.
3. One facet lifecycle spans durable keys, in-memory mirrors, worker identity,
   and recovery paths. Preserve tested abort/start and alarm pins; consolidate
   only after a replacement removes state transitions rather than repacks them.

The biggest potential payoff is relaxing **automatic core-owned durable
delivery to an arbitrary stateless target**. Its 1,962-line broker includes
cursor, retry, fan-out, halt, and dead-letter policy. An ordinary processor
could own that policy instead, using the existing log, storage, and wake
mechanisms. That would retain reliable delivery as a capability while requiring
the consumer to own its progress. This is a recommendation to prove, not a
safe deletion today: config delivery needs the same authority and recovery,
and the SDK replacement must demonstrate them before the broker is removed.

The other measured relaxations are transparent WebSocket forwarding through a
lent provider/project host (978 direct lines), and arbitrary expression-prefix
matching/templates (234 directly exclusive resolver lines). The current source
work tries the latter by replacing templates with ordinary confined worker
code. Dropping WebSocket forwarding would lose existing convenience and needs
a concrete replacement; it is not recommended for this implementation. None
of these counts alone proves a 15–20k core target.

The earlier typed export/descriptor proposal is paused. Its complete report,
evidence ledger, and independent review are retained in
[archived-first-design-full.md](archived-first-design-full.md) and the
supporting documents below because their counterexamples remain useful. They
are not the best current model and must not be resumed without a fresh decision.

## Verified defects and test boundaries

`whileClientAnswers` can probe forever when a provider answers liveness checks
but the original call never settles. That retains a borrowed answer and can pin
an invocation indefinitely. The bounded provider-call lease is a real defect
fix: it returns a typed timeout and releases the caller's borrowed answer. A
larger declared deadline remains available for legitimate long work; a returned
streaming body retains its current ownership and cancellation contract.

The compact facet control-row experiment was parked. It was a net **+26
physical lines** and did not reduce lifecycle branches. The review found a
selected identity could advance ahead of durable identity after failed start, a
missing named-worker generation could roll publication back, and a late
recovery write could recreate state after deletion. It is not part of the
source direction. Keep the established abort/start adjacency and alarm/reset
tests until a replacement proves fewer lifecycle states and a recovery path.
The facet loader's remote-error classifier mismatch also remains an
investigation: add telemetry and parent-side failure injection before changing
retry classification.

The direct provider/subscription area has at least 9,371 test lines. They are
not redundant merely because they are large: unit, Workers, and deployed e2e
exercise distinct failure models. Keep native RPC lifecycle, hibernatable
socket, memory, alarm/watch, abort/reset, and Cap'n Web e2e pins. A test can be
deleted only when its production branch and outcome have a named
equal-or-higher-fidelity replacement.

## Concrete next work and validation

1. Replace durable rewrite interpretation with the simple address-plus-fixed-
   steps mapping, keeping `itx`, `cd`, and `invoke` as the public vocabulary.
2. Make `provide` a live pager attachment only. Validate attach, hibernate,
   reset, redial, detach, route appearance/removal, and a durable name becoming
   visible again after detach.
3. Reject or recreate old `delivery`-less rows before enabling the new reducer;
   do not silently drop config-worker delivery. Test config publication switch,
   Garple jail grants, child/stateless attachments, and unchanged firmware C.
4. Keep ordered delivery, halt/resume, fan-out, and their outcomes. Delete the
   old broker's tests only with a named equal-or-higher-fidelity replacement.
   Retain native RPC, hibernation, alarm, abort/reset, and Cap'n Web e2e pins.
5. Keep project/global built-in assembly in private factories. Add descriptions
   to existing `provide`/list data only where they help; do not make metadata a
   second runtime.

Before an implementation PR counts, require typecheck; relevant unit, Workers,
and deployed e2e rows; latency/throughput and soak evidence; and preview logs
without new unexplained errors. Preview, performance, and soak validation are
authorized by this audit. Production rollout is not.

## Source trail and evidence ledger

- Current code inventory and test ownership: [`tests-inventory.md`](tests-inventory.md), [`core-userspace.md`](core-userspace.md), [`rpc-subscriptions.md`](rpc-subscriptions.md), and [`facets-loader.md`](facets-loader.md).
- Paused delivery-removal proposal: [`design-delivery.md`](design-delivery.md). It remains useful evidence, but cannot justify a current cursor deletion.
- Requirement tradeoffs and Cloudflare comparison: [`requirement-tradeoffs.md`](requirement-tradeoffs.md), [`cloudflare-os-comparison.md`](cloudflare-os-comparison.md), and [`validation-plan.md`](validation-plan.md).
- Archived first-pass framework: [`archived-first-design.md`](archived-first-design.md), [`archived-first-design-full.md`](archived-first-design-full.md), [`exports-not-expressions.md`](exports-not-expressions.md), and [`design-capabilities.md`](design-capabilities.md).
- Independent review records: [facet review](reviews/facets-plan-opus.md), [facet experiment](reviews/facets-control-experiment.md), [exports review](reviews/opus-exports-round-2.md), [lean-model review](reviews/opus-lean-round-3.md), [implementation review, round 4](reviews/opus-implementation-round-4.md), [durable-delivery review, round 5](reviews/opus-durable-delivery-round-5.md), and [private bridge review, round 6](reviews/opus-private-bridge-round-6.md), [direct private delivery review, round 7](reviews/opus-direct-private-delivery-round-7.md), [durable bodies review, round 8](reviews/opus-durable-bodies-round-8.md), [full-access source review, round 9](reviews/opus-root-round-9.md), [round 10](reviews/opus-round-10.md), [round 11](reviews/opus-round-11.md), [round 12](reviews/opus-round-12.md), [round 13](reviews/opus-round-13.md), and [round 14](reviews/opus-round-14.md).
- Cloudflare, workerd, Cap'n Web, and Kenton Varda research synthesis: [`reports/Iterate core runtime review.md`](../../reports/Iterate%20core%20runtime%20review.md) and [targeted primary-source notes](../../research_notes/Iterate%20core%20runtime%20review/).
