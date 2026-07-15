## Verdict

I would block merge at current HEAD `911633eef` until the malformed-head correctness bug and transport finality are fixed. The redesign has a good core, but the runner still contains a speculative operator system, two logically identical cursors, transport compensation, and several processors whose correctness depends on incarnation-local memory.

The branch moved during review. Two requested cleanups are already complete:

- `a8aabc9a7` deleted the legacy Durable Object `{offset,state}` conversion, `StreamProcessorSnapshot`, and `stream-processor-host` keepalive adoption.
- `911633eef` deleted browser `processor_state` and its dual-write/fallback path.

Do not reintroduce either. Keep the current per-incarnation alarm-slice reconciliation; it is current recovery logic, not legacy adoption.

Line references below target `911633eef`. LOC estimates overlap.

## 1. Legacy cruft to delete

### 1. Collapse the seven revival dialects into one core event

The same recovery fact is duplicated in:

- [agent contract:241](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:241)
- [Slack contract:28](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-contract.ts:28)
- [Telegram contract:27](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/telegram-agent-processor-contract.ts:27)
- [email contract:28](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/email/email-agent-processor-contract.ts:28)
- [GitHub contract:57](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/github-agent-processor-contract.ts:57)
- [capability-host contract:77](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:77)
- [repo contract:42](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:42)

That duplication forces dynamic `revivedEventType` plumbing through the runner, durability adapter, registry, and every DO registration: [runner:138](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:138), [durability:119](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/durable-object-processor-durability.ts:119), [registry:174](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:174).

Before:

```ts
register(processor, {
  recovery: { revivedEventType: AGENT_REVIVED_EVENT_TYPE },
});
```

After:

```ts
register(processor, { recovery: true });

// Defined once in core:
stream/processor-revived {
  processorSlug,
  revivals,
  version,
}
```

Gate delivery by `processorSlug`; ideally the selector supports that predicate so one processor’s revival does not wake all peers. Retain one invariant that a recovery-enabled processor consumes the core event.

Rough delta: **−220–250 production LOC**, plus redundant tests and imports.

### 2. Delete revision-zero byte compatibility by deleting the unused reprocessing design

The runner preserves old bytes by conditionally omitting a cursor revision suffix: [runner:170](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:170), [runner:1183](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1183). The base driver is also explicitly documented as “byte-preserved from the legacy engine”: [stream-processor:226](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:226).

Worse, no production processor uses `args.delivery.idempotencyKey`. They all use `this.idempotencyKey(...)`, so `reprocessFrom` does not rotate most real effect keys despite claiming it does.

Before:

```ts
revision === 0 ? baseKey : `${baseKey}:r${revision}`;
```

After:

```ts
// Runner derives no effect keys.
// Processors use one canonical stable event/obligation key format.
this.idempotencyKey(key, event);
```

Delete `DeliveryContext.idempotencyKey`, `#effectIdempotencyKey`, `cursorRevision`, and the compatibility commentary. Retain slug/path/offset collision protection where semantically useful; delete only the legacy conditional and speculative revision behavior.

Rough delta: **−35–50 core LOC**, or **−300–450 including the dead operator surface/tests** described below.

### 3. Delete the remaining flag-day migration branches

These can go outright:

- Browser feed probes/drops retired schemas and rewinds old checkpoints at [browser-feed implementation:127](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/processors/browser-feed/implementation.ts:127). Create only the current tables and indexes. **−25–35 production LOC, −35–45 tests.**

- Browser mirror members deliberately retain a pre-unification subscription identity at [stream-browser-store:526](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:526). With one database per stream, progress should be keyed by processor slug, not old subscription identity. This also removes `subscriptionKey` plumbing from [processor-state-storage:114](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/processor-state-storage.ts:114). **−20–50 LOC now; more after cursor collapse.**

- Scheduler `ScheduleEntry.path` is optional only for legacy snapshots at [scheduler contract:91](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-contract.ts:91), causing a journal fallback at [scheduler implementation:361](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-implementation.ts:361). Require it. **−10–15 production, −35–40 tests.**

- Agent’s raw-journal/backstop compatibility is documented at [agent contract:35](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:35), makes `requestedAt` optional at [contract:463](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:463), and adds a second expiry path at [implementation:775](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-implementation.ts:775). Require normal lifecycle fields and rely on the ordinary expiry obligation. **−45–60 LOC.**

- Capability-host similarly makes `expiresAt` optional for raw appends at [contract:151](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:151). Require it at the contract boundary. **−10–20 LOC.**

- Delete the three historical Codex review memos. They explicitly instruct future work to preserve migrations, rollback compatibility, legacy keepalives, and revision-zero bytes: `docs/stream-processor-runner-codex-review.md`, `docs/stream-processor-runner-codex-agent-review.md`, and `docs/stream-processor-runner-codex-runner-review.md`. **About −110 documentation LOC.**

## 2. Structural collapse / code-judo

### 4. Release blocker: malformed head events can permanently suppress reconciliation

The runner calculates `lastConsumedOffset` from event type before Zod parsing at [runner:804](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:804), then silently skips malformed consumed events at [runner:827](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:827).

Failure:

1. Valid event at offset 1 creates an obligation.
2. Malformed same-type event at raw head offset 2.
3. Offset 1 receives `caughtUp: false` because offset 2 was selected as “last consumed.”
4. Offset 2 never calls `processEvent`.
5. Both offsets are committed.
6. The obligation is stranded until some unrelated future event.

Preferred after:

```ts
const parsed = pending.map((event) => driver.parseConsumedEvent(event));
// A malformed consumed event throws before any frame side effects or commit.

for (const reduction of parsed) {
  processEvent({
    ...reduction,
    caughtUp: reduction === parsed.at(-1) && frame.caughtUp,
  });
}
```

A malformed contract event is a product defect. Hold the cursor and expose the error; do not auto-acknowledge it and hope for a wake. This also deletes much of the parse-failure diagnostic lane.

Rough delta: **−30–70 LOC**, while fixing a correctness defect.

### 5. Give filtered delivery honest finality, then delete self-pull and recheck events

The Stream DO already advances its raw scan cursor before filtering at [stream-subscribers:1030](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-subscribers.ts:1030), but sends only selected events plus the global raw head at [stream-subscribers:1078](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-subscribers.ts:1078). It discards the selector’s scan watermark.

The runner compensates with:

- trailing unfiltered self-pull: [runner:394](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:394)
- duplicated head/consume calculation: [runner:780](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:780)
- another pager: [runner:1149](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1149)
- browser restamping: [composite-mirror-drive:134](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/composite-mirror-drive.ts:134)
- browser stream proxying: [stream-browser-store:2175](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:2175)

Before:

```ts
{ events: selectedEvents, streamMaxOffset: rawGlobalHead }
```

After:

```ts
{
  events: selectedEvents,
  scannedThroughOffset,
  caughtUp: scannedThroughOffset === observedRawHead,
}
```

The selector-aware pump must retain the final selected batch until it has scanned to either another matching event or the observed raw head. Then the runner simply trusts transport finality and commits the scan watermark.

That permits deleting `stream/woken` and `subscriber-connected` as correctness-recheck consumes from [agent contract:1084](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:1084), [repo contract:523](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:523), and [capability contract:233](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:233).

Rough delta: **−200–350 source/test LOC net**, after approximately 40–80 LOC of transport work.

### 6. Collapse the two persisted cursors into one checkpoint

The runner defines independent reduction and processing progress at [runner:50](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:50), but every production writer advances them together:

- normal event: [runner:875](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:875)
- commit: [runner:931](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:931)
- fresh state and controls: [runner:590](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:590)

Only load-healing code and synthetic tests manufacture divergence.

Before:

```ts
{
  reduction: { reducerVersion, reducedThroughOffset, state },
  processing: { acknowledgedThroughOffset, cursorRevision },
}
```

After:

```ts
{
  reducerVersion,
  offset,
  state,
}
```

On reducer-version mismatch, refold reduce-only through `offset`; do not rerun effects. If stale-writer fencing remains necessary in browser storage, keep a storage generation/CAS token separate from logical processor progress.

This also collapses `processor_progress` SQL columns and its revision-fence machinery.

Rough delta: **−150–250 LOC across runner, persistence and tests.**

### 7. Delete the unused operator and cadence systems

There are no non-test callers for:

- `reReduce`: [runner:590](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:590)
- `reprocessFrom`: [runner:616](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:616)
- `skipThrough`: [runner:666](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:666)
- `markLoaded`: [runner:468](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:468)
- configurable checkpoint cadence: [runner:209](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:209)

They are not exposed through the registry, RPC, or an operator UI. They exist to justify cursor revisioning, audit events, mid-frame commit branches, and numerous tests.

After: one atomic commit per byte-bounded transport frame. Introduce operator controls later when a real operator boundary and concrete semantics exist.

Rough delta: **−250–350 production/test LOC**, overlapping with cursor and idempotency estimates.

## 3. Processor homogeneity

Secret is the clean pure-fold baseline. Repo is the closest effectful obligation baseline. Slack, GitHub, Telegram, and Project are furthest from the requested shape.

| Processor       | Current divergence → target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rough delta |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: |
| Agent           | `currentRequest` and `llmRequests` duplicate one lifecycle at [contract:463](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:463) and [contract:518](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:518). Replace with one discriminated `currentRequest: scheduled \| requested \| started`, then delete raw-request scans/backstop paths.                                                       |    −125–180 |
| Scheduler       | Immediate execution from `processEvent` and a second pending-trigger sweep in `triggerDue` at [implementation:208](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-implementation.ts:208). Reducer should record pending triggers; only `processEvent` under `caughtUp` launches them. `triggerDue` only appends requests/repoints alarm.                                                                                                                                     |      −45–70 |
| GitHub          | `#batchConversation` at [implementation:79](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/github-agent-processor-implementation.ts:79) is an ephemeral trust bridge whose correctness assumes verification and follow-ups share one drive. Fold pending webhook/verification obligations and append a durable verification result.                                                                                                                                                                  |      −30–70 |
| Telegram        | Hidden `#unpaintedTypingFact` and O(history) `#findSentMarker` at [implementation:360](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/telegram-agent-processor-implementation.ts:360). Fold `pendingSends` and desired typing state; reconcile and append `message-sent` at head.                                                                                                                                                                                                             |      −40–80 |
| Slack           | Desired/actual status lives in `#unpaintedStatusFact`, `#paintedBusyStatus`, and `#paintedTitle` at [implementation:303](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-implementation.ts:303). Fold desired status plus source offset; consume one painted marker.                                                                                                                                                                                                     |      −35–65 |
| Project         | Wildcard consume at [contract:433](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/projects/project-processor-contract.ts:433), event-time creation saga, and hidden second reducer/dispatcher in [custom-domain-processor:16](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/projects/custom-domain-processor.ts:16). Use exact consumes; fold creation phase and reconcile bootstrap at head. Inline custom-domain cases or make them a genuinely separate processor. |      −20–60 |
| Capability host | Processor plus a large RPC/service class with bespoke manual dependencies at [implementation:152](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:152). Use `StreamProcessor<Contract, CapabilityHostDeps>` and separate the service surface.                                                                                                                                                                                                   |      −45–65 |
| Repo            | Correct obligation model, but `processEvent` is an if-ladder at [implementation:114](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-implementation.ts:114), and webhook payload is an almost-empty loose schema at [contract:462](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:462). Make dispatch exhaustive and type the known envelope.                                                                     |       −5–15 |
| Email           | Structurally close, but attachment failure is caught and the message is forwarded without files at [implementation:108](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/email/email-agent-processor-implementation.ts:108). Delete the silent fallback: block/retry or append an explicit classified failure.                                                                                                                                                                                               |      −10–20 |
| Secret          | Behavioral baseline: pure contract-driven fold. Its Zod state remains a mirror of handwritten durable types, so schema ownership still needs consolidation.                                                                                                                                                                                                                                                                                                                                                                                    |       small |

Slack has the same silent attachment degradation at [Slack implementation:259](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-implementation.ts:259). That violates the repository’s no-unexplained-data-loss rule.

### Make contract Zod schemas the only source of truth

Capability-host, scheduler, and secret define handwritten types elsewhere and then maintain Zod “mirrors”: [capability contract:5](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:5), [scheduler contract:3](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-contract.ts:3), [secret contract:4](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/secrets/secret-processor-contract.ts:4). Project imports parts of its durable schema from other modules.

Before:

```ts
type Schedule = { ... };
const ScheduleSchema = z.object({ ... }) satisfies z.ZodType<Schedule>;
```

After:

```ts
export const ScheduleSchema = z.strictObject({ ... });
export type Schedule = z.infer<typeof ScheduleSchema>;
```

Owned state and events should be visible in the contract; infer all durable types from them. Keep loose schemas only at genuine external boundaries.

Rough delta: **−40–70 LOC**, plus removal of casts and drift risk.

## 4. File size

Deletion should precede decomposition.

- [stream-processor-runner.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1): **1,326 lines**, with a new **1,628-line** test file. The cursor/operator/self-pull/arg deletions should bring production code below roughly 850–950 lines. Only then consider extracting persistence/refold as one cohesive module.

- [agent-processor-implementation.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-implementation.ts:1): **1,773 lines**; contract **1,128**; tests **2,809**. Move the default prompt at contract lines 82–226 out of the contract, and extract the pure reducer currently around implementation lines 1,045–1,367. Keep contract schemas inline.

- [stream-browser-store.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:1): **2,207 lines** and mixes database setup, mirror election, runner hosting, lifecycle and transport compensation. After deleting restamps/proxies/subscription migration, extract mirror election/drive as a cohesive unit.

- `repo-durable-object.ts` is 1,803 lines and `rpc-targets.ts` is 7,076, but this branch changes them only modestly. They are pre-existing decomposition problems, not reasons to preserve redesign complexity.

- Slack and Telegram test files are 1,638 and 1,098 lines. Split them only after duplicated recovery/operator cases are removed.

## 5. Type and boundary cleanup

### Shrink and export the real processor hook boundary

`ReduceArgs` and `ProcessEventArgs` are deliberately private at [stream-processor:65](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:65), forcing dozens of processors to spell:

```ts
Parameters < StreamProcessor < Contract > ["processEvent"] > [0];
```

`ProcessEventArgs` also exposes fields no production processor uses: `streamMaxOffset`, `checkpointOffset`, delivery phase, head offset, lag, revision and delivery-derived idempotency keys at [stream-processor:121](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:121).

After:

```ts
export type ProcessEventArgs<C> = {
  event: ConsumedEvent<C>;
  previousState: ProcessorState<C>;
  state: ProcessorState<C>;
  caughtUp: boolean;
  blockProcessorWhile(...): void;
  runInBackground(...): void;
  append(...): Promise<StreamEvent[]>;
  appendTo(...): Promise<StreamEvent[]>;
};
```

This also removes the wrong-direction type dependency where `stream-processor.ts` imports `DeliveryContext` from the runner.

Rough delta: **−80–150 LOC/comments/tests**.

### Make stream ownership singular and erase types once

The runner independently accepts `processor` and `stream` at [runner:319](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:319), while emitted consequences use the processor’s own stream. `processor(streamA), runner(streamB)` compiles and can fold B while writing to A.

The registry then stores `StreamProcessorRunner<any>` at [registry:136](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:136), casts through `unknown` at [registry:427](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:427), and casts reads back at [registry:484](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:484). Browser hosting repeats the erasure around `stream-browser-store.ts:1300`.

After:

```ts
new StreamProcessorRunner({
  driver: processor.runnerDriver, // owns replay source and append target
});

type RunnerHandle = {
  openDelivery(): ...;
  snapshot(): Promise<ProcessorSnapshot<unknown>>;
  handleAlarm(...): Promise<void>;
};
```

Keep the generic type until registration, then erase once into a narrow operational handle—not the whole generic class.

### Split the waiter APIs and return the matched event

The registry combines offset barriers and event predicates into one `waitUntilEvent` union at [registry:124](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:124), then uses a no-op conditional passthrough at [registry:473](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:473). The runner discards the matched event at [runner:1304](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1304), forcing capability-host to capture mutable outer state and cast payloads.

Use:

```ts
waitUntilOffset(offset): Promise<void>
waitForProcessedEvent<T>(guard): Promise<T>
```

Finally, remove the boundary-defeating `consumes as unknown as [...]` fixture cast at [runner test:65](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.test.ts:65). Build a real const-generic wildcard contract instead.

Overall, after the two cleanup commits already landed, the remaining findings still represent comfortably **more than 1,000 deletable LOC including tests/docs**, before counting processor-specific lifecycle collapse. No files were edited and no tests were run; this was a read-only full-diff review.
440,161

## Verdict

I would block merge at current HEAD `911633eef` until the malformed-head correctness bug and transport finality are fixed. The redesign has a good core, but the runner still contains a speculative operator system, two logically identical cursors, transport compensation, and several processors whose correctness depends on incarnation-local memory.

The branch moved during review. Two requested cleanups are already complete:

- `a8aabc9a7` deleted the legacy Durable Object `{offset,state}` conversion, `StreamProcessorSnapshot`, and `stream-processor-host` keepalive adoption.
- `911633eef` deleted browser `processor_state` and its dual-write/fallback path.

Do not reintroduce either. Keep the current per-incarnation alarm-slice reconciliation; it is current recovery logic, not legacy adoption.

Line references below target `911633eef`. LOC estimates overlap.

## 1. Legacy cruft to delete

### 1. Collapse the seven revival dialects into one core event

The same recovery fact is duplicated in:

- [agent contract:241](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:241)
- [Slack contract:28](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-contract.ts:28)
- [Telegram contract:27](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/telegram-agent-processor-contract.ts:27)
- [email contract:28](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/email/email-agent-processor-contract.ts:28)
- [GitHub contract:57](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/github-agent-processor-contract.ts:57)
- [capability-host contract:77](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:77)
- [repo contract:42](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:42)

That duplication forces dynamic `revivedEventType` plumbing through the runner, durability adapter, registry, and every DO registration: [runner:138](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:138), [durability:119](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/durable-object-processor-durability.ts:119), [registry:174](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:174).

Before:

```ts
register(processor, {
  recovery: { revivedEventType: AGENT_REVIVED_EVENT_TYPE },
});
```

After:

```ts
register(processor, { recovery: true });

// Defined once in core:
stream/processor-revived {
  processorSlug,
  revivals,
  version,
}
```

Gate delivery by `processorSlug`; ideally the selector supports that predicate so one processor’s revival does not wake all peers. Retain one invariant that a recovery-enabled processor consumes the core event.

Rough delta: **−220–250 production LOC**, plus redundant tests and imports.

### 2. Delete revision-zero byte compatibility by deleting the unused reprocessing design

The runner preserves old bytes by conditionally omitting a cursor revision suffix: [runner:170](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:170), [runner:1183](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1183). The base driver is also explicitly documented as “byte-preserved from the legacy engine”: [stream-processor:226](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:226).

Worse, no production processor uses `args.delivery.idempotencyKey`. They all use `this.idempotencyKey(...)`, so `reprocessFrom` does not rotate most real effect keys despite claiming it does.

Before:

```ts
revision === 0 ? baseKey : `${baseKey}:r${revision}`;
```

After:

```ts
// Runner derives no effect keys.
// Processors use one canonical stable event/obligation key format.
this.idempotencyKey(key, event);
```

Delete `DeliveryContext.idempotencyKey`, `#effectIdempotencyKey`, `cursorRevision`, and the compatibility commentary. Retain slug/path/offset collision protection where semantically useful; delete only the legacy conditional and speculative revision behavior.

Rough delta: **−35–50 core LOC**, or **−300–450 including the dead operator surface/tests** described below.

### 3. Delete the remaining flag-day migration branches

These can go outright:

- Browser feed probes/drops retired schemas and rewinds old checkpoints at [browser-feed implementation:127](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/processors/browser-feed/implementation.ts:127). Create only the current tables and indexes. **−25–35 production LOC, −35–45 tests.**

- Browser mirror members deliberately retain a pre-unification subscription identity at [stream-browser-store:526](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:526). With one database per stream, progress should be keyed by processor slug, not old subscription identity. This also removes `subscriptionKey` plumbing from [processor-state-storage:114](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/processor-state-storage.ts:114). **−20–50 LOC now; more after cursor collapse.**

- Scheduler `ScheduleEntry.path` is optional only for legacy snapshots at [scheduler contract:91](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-contract.ts:91), causing a journal fallback at [scheduler implementation:361](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-implementation.ts:361). Require it. **−10–15 production, −35–40 tests.**

- Agent’s raw-journal/backstop compatibility is documented at [agent contract:35](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:35), makes `requestedAt` optional at [contract:463](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:463), and adds a second expiry path at [implementation:775](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-implementation.ts:775). Require normal lifecycle fields and rely on the ordinary expiry obligation. **−45–60 LOC.**

- Capability-host similarly makes `expiresAt` optional for raw appends at [contract:151](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:151). Require it at the contract boundary. **−10–20 LOC.**

- Delete the three historical Codex review memos. They explicitly instruct future work to preserve migrations, rollback compatibility, legacy keepalives, and revision-zero bytes: `docs/stream-processor-runner-codex-review.md`, `docs/stream-processor-runner-codex-agent-review.md`, and `docs/stream-processor-runner-codex-runner-review.md`. **About −110 documentation LOC.**

## 2. Structural collapse / code-judo

### 4. Release blocker: malformed head events can permanently suppress reconciliation

The runner calculates `lastConsumedOffset` from event type before Zod parsing at [runner:804](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:804), then silently skips malformed consumed events at [runner:827](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:827).

Failure:

1. Valid event at offset 1 creates an obligation.
2. Malformed same-type event at raw head offset 2.
3. Offset 1 receives `caughtUp: false` because offset 2 was selected as “last consumed.”
4. Offset 2 never calls `processEvent`.
5. Both offsets are committed.
6. The obligation is stranded until some unrelated future event.

Preferred after:

```ts
const parsed = pending.map((event) => driver.parseConsumedEvent(event));
// A malformed consumed event throws before any frame side effects or commit.

for (const reduction of parsed) {
  processEvent({
    ...reduction,
    caughtUp: reduction === parsed.at(-1) && frame.caughtUp,
  });
}
```

A malformed contract event is a product defect. Hold the cursor and expose the error; do not auto-acknowledge it and hope for a wake. This also deletes much of the parse-failure diagnostic lane.

Rough delta: **−30–70 LOC**, while fixing a correctness defect.

### 5. Give filtered delivery honest finality, then delete self-pull and recheck events

The Stream DO already advances its raw scan cursor before filtering at [stream-subscribers:1030](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-subscribers.ts:1030), but sends only selected events plus the global raw head at [stream-subscribers:1078](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-subscribers.ts:1078). It discards the selector’s scan watermark.

The runner compensates with:

- trailing unfiltered self-pull: [runner:394](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:394)
- duplicated head/consume calculation: [runner:780](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:780)
- another pager: [runner:1149](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1149)
- browser restamping: [composite-mirror-drive:134](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/composite-mirror-drive.ts:134)
- browser stream proxying: [stream-browser-store:2175](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:2175)

Before:

```ts
{ events: selectedEvents, streamMaxOffset: rawGlobalHead }
```

After:

```ts
{
  events: selectedEvents,
  scannedThroughOffset,
  caughtUp: scannedThroughOffset === observedRawHead,
}
```

The selector-aware pump must retain the final selected batch until it has scanned to either another matching event or the observed raw head. Then the runner simply trusts transport finality and commits the scan watermark.

That permits deleting `stream/woken` and `subscriber-connected` as correctness-recheck consumes from [agent contract:1084](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:1084), [repo contract:523](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:523), and [capability contract:233](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:233).

Rough delta: **−200–350 source/test LOC net**, after approximately 40–80 LOC of transport work.

### 6. Collapse the two persisted cursors into one checkpoint

The runner defines independent reduction and processing progress at [runner:50](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:50), but every production writer advances them together:

- normal event: [runner:875](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:875)
- commit: [runner:931](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:931)
- fresh state and controls: [runner:590](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:590)

Only load-healing code and synthetic tests manufacture divergence.

Before:

```ts
{
  reduction: { reducerVersion, reducedThroughOffset, state },
  processing: { acknowledgedThroughOffset, cursorRevision },
}
```

After:

```ts
{
  reducerVersion,
  offset,
  state,
}
```

On reducer-version mismatch, refold reduce-only through `offset`; do not rerun effects. If stale-writer fencing remains necessary in browser storage, keep a storage generation/CAS token separate from logical processor progress.

This also collapses `processor_progress` SQL columns and its revision-fence machinery.

Rough delta: **−150–250 LOC across runner, persistence and tests.**

### 7. Delete the unused operator and cadence systems

There are no non-test callers for:

- `reReduce`: [runner:590](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:590)
- `reprocessFrom`: [runner:616](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:616)
- `skipThrough`: [runner:666](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:666)
- `markLoaded`: [runner:468](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:468)
- configurable checkpoint cadence: [runner:209](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:209)

They are not exposed through the registry, RPC, or an operator UI. They exist to justify cursor revisioning, audit events, mid-frame commit branches, and numerous tests.

After: one atomic commit per byte-bounded transport frame. Introduce operator controls later when a real operator boundary and concrete semantics exist.

Rough delta: **−250–350 production/test LOC**, overlapping with cursor and idempotency estimates.

## 3. Processor homogeneity

Secret is the clean pure-fold baseline. Repo is the closest effectful obligation baseline. Slack, GitHub, Telegram, and Project are furthest from the requested shape.

| Processor       | Current divergence → target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rough delta |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: |
| Agent           | `currentRequest` and `llmRequests` duplicate one lifecycle at [contract:463](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:463) and [contract:518](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-contract.ts:518). Replace with one discriminated `currentRequest: scheduled \| requested \| started`, then delete raw-request scans/backstop paths.                                                       |    −125–180 |
| Scheduler       | Immediate execution from `processEvent` and a second pending-trigger sweep in `triggerDue` at [implementation:208](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-implementation.ts:208). Reducer should record pending triggers; only `processEvent` under `caughtUp` launches them. `triggerDue` only appends requests/repoints alarm.                                                                                                                                     |      −45–70 |
| GitHub          | `#batchConversation` at [implementation:79](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/github-agent-processor-implementation.ts:79) is an ephemeral trust bridge whose correctness assumes verification and follow-ups share one drive. Fold pending webhook/verification obligations and append a durable verification result.                                                                                                                                                                  |      −30–70 |
| Telegram        | Hidden `#unpaintedTypingFact` and O(history) `#findSentMarker` at [implementation:360](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/telegram-agent-processor-implementation.ts:360). Fold `pendingSends` and desired typing state; reconcile and append `message-sent` at head.                                                                                                                                                                                                             |      −40–80 |
| Slack           | Desired/actual status lives in `#unpaintedStatusFact`, `#paintedBusyStatus`, and `#paintedTitle` at [implementation:303](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-implementation.ts:303). Fold desired status plus source offset; consume one painted marker.                                                                                                                                                                                                     |      −35–65 |
| Project         | Wildcard consume at [contract:433](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/projects/project-processor-contract.ts:433), event-time creation saga, and hidden second reducer/dispatcher in [custom-domain-processor:16](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/projects/custom-domain-processor.ts:16). Use exact consumes; fold creation phase and reconcile bootstrap at head. Inline custom-domain cases or make them a genuinely separate processor. |      −20–60 |
| Capability host | Processor plus a large RPC/service class with bespoke manual dependencies at [implementation:152](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:152). Use `StreamProcessor<Contract, CapabilityHostDeps>` and separate the service surface.                                                                                                                                                                                                   |      −45–65 |
| Repo            | Correct obligation model, but `processEvent` is an if-ladder at [implementation:114](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-implementation.ts:114), and webhook payload is an almost-empty loose schema at [contract:462](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/repos/repo-processor-contract.ts:462). Make dispatch exhaustive and type the known envelope.                                                                     |       −5–15 |
| Email           | Structurally close, but attachment failure is caught and the message is forwarded without files at [implementation:108](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/email/email-agent-processor-implementation.ts:108). Delete the silent fallback: block/retry or append an explicit classified failure.                                                                                                                                                                                               |      −10–20 |
| Secret          | Behavioral baseline: pure contract-driven fold. Its Zod state remains a mirror of handwritten durable types, so schema ownership still needs consolidation.                                                                                                                                                                                                                                                                                                                                                                                    |       small |

Slack has the same silent attachment degradation at [Slack implementation:259](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/integrations/slack-agent-processor-implementation.ts:259). That violates the repository’s no-unexplained-data-loss rule.

### Make contract Zod schemas the only source of truth

Capability-host, scheduler, and secret define handwritten types elsewhere and then maintain Zod “mirrors”: [capability contract:5](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/capability-host/capability-host-processor-contract.ts:5), [scheduler contract:3](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/scheduler/scheduler-processor-contract.ts:3), [secret contract:4](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/secrets/secret-processor-contract.ts:4). Project imports parts of its durable schema from other modules.

Before:

```ts
type Schedule = { ... };
const ScheduleSchema = z.object({ ... }) satisfies z.ZodType<Schedule>;
```

After:

```ts
export const ScheduleSchema = z.strictObject({ ... });
export type Schedule = z.infer<typeof ScheduleSchema>;
```

Owned state and events should be visible in the contract; infer all durable types from them. Keep loose schemas only at genuine external boundaries.

Rough delta: **−40–70 LOC**, plus removal of casts and drift risk.

## 4. File size

Deletion should precede decomposition.

- [stream-processor-runner.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1): **1,326 lines**, with a new **1,628-line** test file. The cursor/operator/self-pull/arg deletions should bring production code below roughly 850–950 lines. Only then consider extracting persistence/refold as one cohesive module.

- [agent-processor-implementation.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/agents/agent-processor-implementation.ts:1): **1,773 lines**; contract **1,128**; tests **2,809**. Move the default prompt at contract lines 82–226 out of the contract, and extract the pure reducer currently around implementation lines 1,045–1,367. Keep contract schemas inline.

- [stream-browser-store.ts](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:1): **2,207 lines** and mixes database setup, mirror election, runner hosting, lifecycle and transport compensation. After deleting restamps/proxies/subscription migration, extract mirror election/drive as a cohesive unit.

- `repo-durable-object.ts` is 1,803 lines and `rpc-targets.ts` is 7,076, but this branch changes them only modestly. They are pre-existing decomposition problems, not reasons to preserve redesign complexity.

- Slack and Telegram test files are 1,638 and 1,098 lines. Split them only after duplicated recovery/operator cases are removed.

## 5. Type and boundary cleanup

### Shrink and export the real processor hook boundary

`ReduceArgs` and `ProcessEventArgs` are deliberately private at [stream-processor:65](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:65), forcing dozens of processors to spell:

```ts
Parameters < StreamProcessor < Contract > ["processEvent"] > [0];
```

`ProcessEventArgs` also exposes fields no production processor uses: `streamMaxOffset`, `checkpointOffset`, delivery phase, head offset, lag, revision and delivery-derived idempotency keys at [stream-processor:121](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor.ts:121).

After:

```ts
export type ProcessEventArgs<C> = {
  event: ConsumedEvent<C>;
  previousState: ProcessorState<C>;
  state: ProcessorState<C>;
  caughtUp: boolean;
  blockProcessorWhile(...): void;
  runInBackground(...): void;
  append(...): Promise<StreamEvent[]>;
  appendTo(...): Promise<StreamEvent[]>;
};
```

This also removes the wrong-direction type dependency where `stream-processor.ts` imports `DeliveryContext` from the runner.

Rough delta: **−80–150 LOC/comments/tests**.

### Make stream ownership singular and erase types once

The runner independently accepts `processor` and `stream` at [runner:319](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:319), while emitted consequences use the processor’s own stream. `processor(streamA), runner(streamB)` compiles and can fold B while writing to A.

The registry then stores `StreamProcessorRunner<any>` at [registry:136](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:136), casts through `unknown` at [registry:427](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:427), and casts reads back at [registry:484](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:484). Browser hosting repeats the erasure around `stream-browser-store.ts:1300`.

After:

```ts
new StreamProcessorRunner({
  driver: processor.runnerDriver, // owns replay source and append target
});

type RunnerHandle = {
  openDelivery(): ...;
  snapshot(): Promise<ProcessorSnapshot<unknown>>;
  handleAlarm(...): Promise<void>;
};
```

Keep the generic type until registration, then erase once into a narrow operational handle—not the whole generic class.

### Split the waiter APIs and return the matched event

The registry combines offset barriers and event predicates into one `waitUntilEvent` union at [registry:124](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:124), then uses a no-op conditional passthrough at [registry:473](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-registry.ts:473). The runner discards the matched event at [runner:1304](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:1304), forcing capability-host to capture mutable outer state and cast payloads.

Use:

```ts
waitUntilOffset(offset): Promise<void>
waitForProcessedEvent<T>(guard): Promise<T>
```

Finally, remove the boundary-defeating `consumes as unknown as [...]` fixture cast at [runner test:65](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.test.ts:65). Build a real const-generic wildcard contract instead.

Overall, after the two cleanup commits already landed, the remaining findings still represent comfortably **more than 1,000 deletable LOC including tests/docs**, before counting processor-specific lifecycle collapse. No files were edited and no tests were run; this was a read-only full-diff review.
