# Stream Processor Runner Sketches

Draft. This is a design scratchpad, not a committed API.

## Vocabulary

`processor`
: A contract plus implementation. It owns schemas, reduced state, pure
reduction, and optional hooks such as `onStart` and `afterAppend`.

`processor contract`
: The frontend-safe part: event schemas, state schema, reducer, event docs,
`consumes`, and `emits`. This may be imported by frontend UI, tests, docs
tooling, and other processors.

`processor implementation`
: The backend-only part: hook code plus runtime dependencies such as Cloudflare
bindings, third-party API clients, dynamic worker loaders, MCP connections,
timers, and service bindings. This must not be imported by frontend code.
Frontend code imports contracts/reducers only.

`runner`
: The thing that decides where events come from, where state is stored, when
hooks run, and how `streamApi` is implemented.

`append authority`
: The special `stream.ts` case: the runner that owns the stream log itself. It
assigns offsets, enforces idempotency, commits event rows, commits reduced
state, and fans events out to subscribers. This is important but rare; most
processors will run outside the stream append path.

The three runners below should share small lifecycle helpers where possible, but
they are not the same deployment shape.

## Shared Lifecycle Helper Shape

The common helper should stay boring:

```ts
type StoredProcessor<Processor> = {
  processor: Processor;
  state: ProcessorState<Processor["contract"]>;
};

type PendingAfterAppend<Contract> = {
  offset: number;
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
};

function reduceCommittedEvent<Processor>(args: {
  storedProcessor: StoredProcessor<Processor>;
  event: StreamEvent;
}): ProcessorReduction<Processor["contract"]> | undefined;

async function runLiveAfterAppend<Processor>(args: {
  storedProcessor: StoredProcessor<Processor>;
  reduction: ProcessorReduction<Processor["contract"]>;
  streamApi: ProcessorStreamApi<Processor["contract"]>;
  signal: AbortSignal;
}): Promise<void>;
```

This helper should not know about SQLite, KV, WebSockets, Durable Objects,
polling, or stream paths. Runners own those concerns.

## 1. Singleton Stream Runner

This is `apps/events/src/durable-objects/stream.ts`.

This runner is the stream. It is not subscribing to a stream; it is the append
authority. Do not overgeneralize from this runner: only a small set of builtin
processors should run here.

Responsibilities:

- initialize stream storage and top-level stream state
- parse append input
- enforce idempotency
- assign the next offset
- enforce offset preconditions
- run builtin-only `beforeAppend`
- insert the event row
- commit all reduced state slices in the same SQLite transaction
- publish the committed event to live readers
- run post-commit side effects with `ctx.waitUntil`
- expose `read`, `subscribe`, and `append`

Important distinction:

`beforeAppend` only exists here because builtin processors are physically inside
the append authority. Ordinary remote processors cannot have this hook.

Sketch:

```ts
class StreamDurableObject {
  append(input: EventInput): Event {
    const existing = lookupByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const offset = this.runBeforeAppend(input);
    const event = commitEnvelope({ input, offset, streamPath: this.path });

    const nextCoreState = reduceStreamCore({ state: this.coreState, event });
    const nextProcessorStates = reduceBuiltinProcessors({
      storedProcessors: this.builtinStoredProcessors,
      event,
    });

    transaction(() => {
      insertEvent(event);
      saveCoreState(nextCoreState);
      saveProcessorStates(nextProcessorStates);
    });

    this.coreState = nextCoreState;
    this.builtinStoredProcessors = nextProcessorStates;

    this.publish(event);
    this.ctx.waitUntil(this.runAfterAppendForBuiltinStoredProcessors(event));

    return event;
  }
}
```

What can be extracted:

- event schema validation for processor-owned events
- reduction of a list of processor storedProcessors
- `afterAppend` invocation for a reduction result
- maybe a typed builtin storedProcessor adapter

What should stay in `stream.ts`:

- offset assignment
- event row insert
- idempotency lookup
- transactional commit
- subscriber fanout
- ancestor stream propagation
- stream initialization
- destroy

Open risk:

`stream.ts` currently has old `BuiltinProcessor` values from
`@iterate-com/events-contract/sdk`. We probably need an adapter before replacing
those with the new processor contracts.

## 2. Durable Object Processor Runner

This is the shape for `AgentProcessorDO`, `CodemodeProcessorDO`, or a composed
`AgentRuntimeDO` that mounts both.

This runner is not the append authority. It receives committed events from a
stream, stores reduced state locally, and appends derived events back through
the stream API.

Responsibilities:

- bind one or more processors to one stream path
- create a scoped `streamApi`
- load cached processor state from DO storage
- catch up from the stream if needed
- call `onStart` after state is current
- receive live committed events from a WebSocket subscription or service binding
- reduce each processor slice independently
- persist each changed slice
- run `afterAppend` only for live consumed events
- use `ctx.waitUntil` for hook work the runner should keep alive
- own runtime-only state such as timers, abort controllers, request sequence
  counters, and open connections
- instantiate processor implementations with runtime dependencies such as
  Cloudflare bindings, service bindings, third-party API clients, loaders, and
  MCP connection handles

Design goal:

This should eventually be expressible as a Durable Object mixin in
`packages/shared/src/durable-object-utils`, roughly:

```ts
export class AgentProcessorDO extends withStreamProcessor({
  createProcessors(instance) {
    return {
      agent: createAgentProcessor({
        runtime: instance.agentRuntime(),
      }),
      codemode: createCodemodeProcessor({
        loader: instance.env.LOADER,
        outboundFetch: instance.env.CODEMODE_OUTBOUND_FETCH,
        env: instance.env,
      }),
    };
  },
})(DurableObject) {
  agentRuntime() {
    // Runner-specific timers, request ids, cancellation, and LLM run plumbing.
  }
}
```

The mixin should own generic runner mechanics: stream binding, state persistence,
catch-up, `onStart`, live delivery, and scoped `streamApi`. The concrete class
should own runtime dependencies and processor-specific runtime state.

Sketch:

```ts
class AgentProcessorDO extends DurableObject {
  storedProcessors = {
    agent: createAgentProcessor({ runtime: this.agentRuntime() }),
    codemode: createCodemodeProcessor({
      loader: this.env.LOADER,
      outboundFetch: this.env.CODEMODE_OUTBOUND_FETCH,
      env: this.env,
    }),
  };

  async start() {
    const hostState = await this.loadHostState();
    const caughtUp = await catchUpStoredProcessors({
      storedProcessors: this.storedProcessors,
      hostState,
      streamApi: this.streamApi,
    });

    await this.saveHostState(caughtUp);

    for (const storedProcessor of Object.values(this.storedProcessors)) {
      await runProcessorOnStart({
        processor: storedProcessor.processor,
        state: caughtUp[storedProcessor.key].state,
        streamApi: this.streamApiFor(storedProcessor.processor.contract),
        signal: this.abort.signal,
      });
    }

    this.ctx.waitUntil(this.consumeLiveSubscription());
  }

  async onCommittedEvent(event: StreamEvent) {
    for (const storedProcessor of Object.values(this.storedProcessors)) {
      const reduction = runProcessorReduce({
        processor: storedProcessor.processor,
        state: storedProcessor.state,
        event,
      });
      if (reduction == null) continue;

      storedProcessor.state = reduction.state;
      await this.saveStoredProcessorState(storedProcessor);

      this.ctx.waitUntil(
        runProcessorAfterAppend({
          processor: storedProcessor.processor,
          ...reduction,
          streamApi: this.streamApiFor(storedProcessor.processor.contract),
          signal: this.abort.signal,
        }),
      );
    }
  }
}
```

The implementation files passed into this runner are backend-only. For example,
`createCodemodeProcessor(...)` imports callable dispatch, dynamic worker
runtime, Worker bindings, and `CloudflareEnv`. That file must never become a
frontend import. UI code that wants agent/codemode state imports only
`AgentProcessorContract`, `CodemodeProcessorContract`, and their reducers.

The composed case is important:

- agent and codemode state slices stay separate
- codemode can carry `state.processorDeps.agent` if it relies on agent state
- no correctness should depend on in-process processor order
- if agent and codemode later split across the network, the event protocol stays
  the same

First production-ish runner decision:

Do not implement durable `afterAppend` retry yet. Run `afterAppend` best-effort
after state is reduced and persisted. Processor authors should use stable
idempotency keys for derived appends, but the runner will not persist pending
effect records in the first pass.

Later:

If/when we need reliable post-commit side effects, offsets alone are not enough.
The runner must persist a pending effect record with the parsed event, previous
state, and next state, because `afterAppend` receives all three values.

## 3. Pull Subscription Runner

This is for a processor running outside the stream DO, maybe in a worker,
daemon, scheduled job, or system-managed processor.

It is also not the append authority.

Responsibilities:

- bind a processor to a stream path
- load persisted processor state and progress
- read historical events after the last reduced offset
- reduce historical events without running `afterAppend`
- call `onStart` after historical catch-up
- subscribe or poll for live events from the last observed offset
- reduce live events, persist state, then run `afterAppend`
- append derived events through scoped `streamApi`
- recover after restarts without missing events

First attachment policy:

- Initial attach to an existing stream should usually replay history reduce-only.
  This builds current state without running old side effects.
- The runner must establish a side-effect boundary for first attach. Events at or
  before that boundary are historical and run through `reduce` only. Events
  after that boundary are live from this processor's perspective and may run
  `afterAppend`.
- Prefer an offset boundary over a time boundary. A time fudge such as
  "created after attach time minus 200ms" is a fallback for APIs that cannot
  expose a cursor, but it is weaker than an offset because clocks, commit
  delays, and batching can all make time semantics fuzzy.
- A clean stream API would expose either `read({ beforeOffset: "end" })` with a
  returned `endOffset`, or `subscribe({ afterOffset })` with an explicit
  `startedAfterOffset`. Without that, a runner can infer the boundary from the
  last replayed event only when history is non-empty.
- Restart after this runner has already attached is different: missed live events
  should be reduced and should enqueue `afterAppend` work, because they were
  live from this processor's perspective.
- The policy is not part of the processor contract. It can be declared as a
  backend processor default, and the runner deployment can override it:

```ts
implementProcessor(AgentProcessorContract, {
  firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },
  async afterAppend(args) {
    // API calls and derived appends.
  },
});
```

The runner stores the result of applying that policy:

```ts
type StoredProcessorState<Contract> = {
  state: ProcessorState<Contract>;
  hasCompletedFirstAttach: boolean;
  liveAfterOffset: number;
  reducedThroughOffset: number;
  afterAppendCompletedThroughOffset: number;
};
```

Sketch:

```ts
async function runPullProcessorRunner(args: {
  processor: Processor;
  streamPath: string;
  storage: ProcessorRunnerStorage;
  streamApi: UnboundStreamApi;
  signal: AbortSignal;
}) {
  const storedProcessor = await args.storage.loadProcessorState(args.processor.contract);
  const streamApi = createScopedStreamApi({
    streamPath: args.streamPath,
    streamApi: args.streamApi,
  });

  const history = await streamApi.read({
    afterOffset: storedProcessor.reducedThroughOffset,
  });

  for (const event of history) {
    const reduction = runProcessorReduce({
      processor: args.processor,
      state: storedProcessor.state,
      event,
    });
    if (reduction == null) continue;

    storedProcessor.state = reduction.state;
    storedProcessor.reducedThroughOffset = event.offset;

    // First pass: catch-up is reduce-only. Durable pending effect records are a
    // later reliability feature, not part of the first production-ish runner.
  }

  await args.storage.saveProcessorState(storedProcessor);
  storedProcessor.initialReplayComplete = true;

  await runProcessorOnStart({
    processor: args.processor,
    state: storedProcessor.state,
    streamApi,
    signal: args.signal,
  });

  for await (const event of streamApi.subscribe({
    afterOffset: storedProcessor.reducedThroughOffset,
    signal: args.signal,
  })) {
    const reduction = runProcessorReduce({
      processor: args.processor,
      state: storedProcessor.state,
      event,
    });
    if (reduction == null) continue;

    storedProcessor.state = reduction.state;
    storedProcessor.reducedThroughOffset = event.offset;
    await args.storage.saveProcessorState(storedProcessor);

    await runProcessorAfterAppend({
      processor: args.processor,
      ...reduction,
      streamApi,
      signal: args.signal,
    });
  }
}
```

Open risk:

The read-then-subscribe boundary can miss events unless the stream API supports
a cursor-stable handoff. The safer contract is: subscribe from the exact last
reduced offset, and let the stream deliver backlog plus live events from that
point. A separate `read(... before: "end")` plus `subscribe(after: "end")` is
not safe.

There are two subtly different cursors:

- `reducedThroughOffset`: the last event included in this processor's reduced
  state.
- `liveFromOffset`: the offset after which this processor is allowed to run
  `afterAppend`.

On first attach, `reducedThroughOffset` advances through historic replay and
`liveFromOffset` is set to the end offset observed at attach. On restart,
`liveFromOffset` should already exist, so events after it are not ancient even
if they are delivered as backlog during catch-up.

Later risk: pending `afterAppend` failure policy is product behavior, not just
plumbing. A permanently failing hook should probably pause that processor on
that stream rather than silently advance its effect cursor. This is deliberately
out of scope for the first production-ish runner.

## Things These Runners Should Share

- resolving whether an event is consumed
- parsing consumed event payloads
- pure reducer invocation
- `previousState` / `state` packaging for `afterAppend`
- typed scoped `streamApi`
- validation that emitted events are declared in `emits`

## Well-Behaved Processor Extras

`wellBehavedProcessorDefaults` currently captures the base state and behavior
ordinary processors should share, starting with processor registration:

- reduced state field: `hasRegisteredCurrentVersion`
- consumes/emits core processor registration event
- reducer fragment for observing the registration event
- `afterAppend` fragment for appending registration exactly once

A likely next well-behaved behavior is debug reporting:

- core event: `events.iterate.com/core/processor-debug-info-requested`
- core event: `events.iterate.com/core/processor-debug-info-provided`
- request payload can target one processor slug or all processors on the stream
- each processor may respond with current reduced state plus any extra
  implementation-defined diagnostic info

This should probably be a normal core event pair, not an out-of-band runner API.
It gives pull processors, DO processors, and builtin processors the same
debugging shape. The implementation hook can decide what runtime-only details
are safe to expose.

## Things These Runners Should Not Share

- storage backend
- transaction model
- offset assignment
- event arrival mechanism
- retry policy
- `beforeAppend`
- state envelope naming, until we settle the runner progress model

## First Recommendation

Build a test-only runner harness before production wiring.

The harness should mount agent and codemode into one in-memory stream with
separate state slices. It should prove:

- append assigns offsets
- both processors reduce the same committed event independently
- codemode embeds `state.processorDeps.agent`
- `afterAppend` appends derived events back into the same log
- derived events are processed as later offsets
- no assertion relies on processor array order

If that harness feels coherent, then adapt either the Agent DO or one simple
`stream.ts` builtin. Do not start with `stream.ts` as the first migration target.

## Questions To Resolve

1. Resolved for first pass: `afterAppend` is best-effort. No durable pending
   effect records yet.
2. On first attachment to an existing stream, should a processor replay history
   reduce-only, start at the tail, or support both policies explicitly?
3. Should a composed DO runner persist one envelope per processor or one document
   containing all mounted processor storedProcessors?
4. Should the first real runner be an in-memory test harness, the Agent DO runner,
   or a simple builtin adapter in `stream.ts`?
