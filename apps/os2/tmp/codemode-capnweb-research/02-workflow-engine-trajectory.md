# Workflow Engine Trajectory for Event-Sourced Codemode

Date: 2026-05-06

## Executive summary

The future-proof shape is not "store the live Cap'n Web handle in the event log" and not "make every codemode script one long Durable Object RPC". Keep three planes separate:

1. **Event log as truth:** append requested, accepted/started, checkpointed/suspended, resumed, cancelled, completed, and failed facts. This is the replayable audit trail and the UI trace.
2. **Workflow engine as durable continuation:** use Cloudflare Workflows or Dynamic Workflows when a script can span sleeps, human approvals, webhook waits, retries, or days/weeks of wall time. Treat Workflow instance state/log retention as operational state, not the canonical source of truth.
3. **Cap'n Web / Workers RPC as ephemeral authority:** pass live `RpcTarget` capabilities only inside one active execution graph. Persist serializable descriptors, handle IDs, scopes, leases, and correlation IDs in events so a resumed step can re-mint equivalent live handles.

The local code is already close to this split. `StreamDurableObject` owns an append-only SQLite event log plus reduced state. `CodemodeSession` is a Durable Object that reacts to `script-execution-requested` and launches a Dynamic Worker with narrow `RpcTarget` facades. The missing piece is a durable continuation model for work that cannot finish inside one warm instance or one direct RPC call.

Recommendation: keep the stream processor and `CodemodeSession` as the durable authority and trace writer, but introduce a workflow runner abstraction whose implementations can be:

- current one-shot Dynamic Worker executor for short scripts;
- Cloudflare Workflow/Dynamic Workflow executor for long scripts;
- later, a custom DO scheduler only for cases Workflows cannot model.

## Primary-source grounding

Cloudflare Workflows provide durable multi-step execution, retries, pause/resume/terminate, sleeps, and waits for external events. The docs explicitly target minutes, hours, or weeks of persisted state and note durable multi-step execution without timeouts. Source: [Cloudflare Workflows overview](https://developers.cloudflare.com/workflows/).

Workflow steps are the durable unit. `step.do()` results are persisted and not re-run after success, `step.sleep()`/`sleepUntil()` suspend execution, and `step.waitForEvent()` waits for external events. Dynamic Workflows specifically says a Dynamic Worker can define workflow steps, sleep for hours/days, wait for external events, and resume after isolate recycling. Source: [Dynamic Workflows docs](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/).

Important Cloudflare limits and semantics:

- A Workflow instance can run forever as long as step CPU and step-count limits are respected; paid defaults are 10,000 steps, configurable to 25,000. Source: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).
- `step.sleep` can be up to 365 days and does not count toward the max step limit. Source: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).
- `waiting` instances, including sleep/retry/event waits, do not count toward concurrency limits. Source: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).
- Non-stream step results and event payloads are capped at 1 MiB; total persisted instance state is capped. Large artifacts should go to R2/external storage with references in workflow state. Source: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) and [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
- Completed Workflow instance state/log retention is limited, currently 3 days free and 30 days paid, so Workflows cannot be the canonical audit log for codemode. Source: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).
- `WorkflowEvent.payload` is effectively immutable and mutations are not persisted across steps; durable state should come from step returns. Source: [Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/).
- Side effects outside `step.do()` can repeat after a restart; non-serializable resources should be created outside steps but not reused across steps. Source: [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).

Durable Objects are useful as identity, coordination, storage, and RPC endpoints, but they are not a weeks-long in-memory continuation model. They can hibernate or be evicted, and hibernation discards in-memory state. In-flight RPC/HTTP requests may be interrupted on shutdown if they touch storage. Source: [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). New DO projects should prefer RPC methods for DO invocation, and RPC calls are async and accept/return serializable values. Source: [Invoke methods on Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/).

Workers RPC / Cap'n Web is the right model for live capability passing, not persistence. Workers RPC supports structured-clone-like values plus functions, `RpcTarget` objects, streams, Requests/Responses, and stubs, with promise pipelining. Source: [Workers RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/). Kenton Varda frames Cap'n Web as object-capability RPC: functions and objects can be passed by reference, stubs cannot be forged, and promise pipelining lets dependent RPC calls collapse into one round trip. Source: [Cap'n Web blog](https://blog.cloudflare.com/capnweb-javascript-rpc-library/) and [JavaScript-native Workers RPC blog](https://blog.cloudflare.com/javascript-native-rpc/).

The Cloudflare Code Mode framing matches this repo's direction: MCP/tool surfaces become TypeScript APIs, code runs in disposable isolates, Internet access is blocked, and the only authority comes from bindings/RPC APIs passed into the sandbox. Source: [Code Mode blog](https://blog.cloudflare.com/code-mode/).

## Local architecture observed

Key files inspected:

- `packages/shared/src/streams/stream-durable-object.ts`
- `packages/shared/src/stream-processors/stream-processor.ts`
- `packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts`
- `packages/shared/src/stream-processors/codemode/contract.ts`
- `packages/shared/src/stream-processors/codemode/implementation.ts`
- `apps/os2/src/durable-objects/codemode-session.ts`
- `apps/os2/src/codemode/codemode-session-rpc.ts`
- `apps/os2/src/orpc/routers/codemode.ts`
- `apps/os2/tmp/codemode-rpc-providers-poc/README.md`
- `apps/os2/tasks/codemode-session-night-plan.md`
- `docs/events.md`

Current durable truth:

- A stream Durable Object owns one append-only event log in SQLite and a `reduced_state` row.
- Append lifecycle is parse, idempotency, `beforeAppend`, reduce, commit, `afterAppend`.
- Idempotency keys already let processors retry derived appends safely.
- Stream processor runner state stores `reducedThroughOffset` and `afterAppendCompletedThroughOffset`.

Current codemode behavior:

- `CodemodeSession` identity is `{ projectId, streamPath }`.
- `createSession` can append initial events, provider registrations, and `script-execution-requested`.
- `startScriptExecution` returns the committed request event immediately.
- `createCodemodeProcessor` reacts to `script-execution-requested`, calls an injected `CodemodeScriptExecutor`, emits logs, emits `function-call-requested`, waits for `function-call-completed`, then emits `script-execution-completed`.
- `apps/os2/src/durable-objects/codemode-session.ts` uses Worker Loader to create a dynamic worker and passes narrow `RpcTarget` facades: `CodemodeSessionCapabilityTarget` and `CodemodeLoggerTarget`.
- The prior POC proved the important RPC point: pass a small `RpcTarget` broker/facade, not a JS `Proxy` and not a raw `DurableObject` instance. The README notes passing the literal `CodemodeSession` DO stub failed with a `DataCloneError`.

Important local limitation:

- The production `processorStreamApiFromNamespace().subscribe()` currently throws because live events arrive through `afterAppend` RPC, while `waitForFunctionCallResult()` expects `read()` then `subscribe()`. That means the current shape is fine for short, synchronous-enough executions and proofs, but not a durable wait across future events. This is exactly where the workflow trajectory matters.

## Design stance

### Events represent durable facts, not live state

Keep following `docs/events.md`: events are facts. A `*-requested` event is acceptable because it records the fact that a request exists. Avoid command-shaped events like `run-script-now`.

For long-running codemode, the event stream should show:

- a request was made;
- an execution was accepted by a runner;
- a step/function call was requested;
- a step/function call produced output, failed, suspended, resumed, timed out, or was cancelled;
- a script completed, failed, or was cancelled;
- a workflow/runner checkpoint was written.

Events should not contain:

- `RpcTarget` stubs;
- DO stubs;
- JS functions;
- `AbortSignal`;
- open streams;
- DB connections;
- provider implementation objects;
- unbounded result blobs.

Those belong to the live capability plane. Events should contain references: `scriptExecutionId`, `runId`, `workflowInstanceId`, `stepId`, `functionCallId`, `providerHandleId`, `descriptorRef`, `artifactRef`, offsets, parent IDs, scope IDs, and serialized payload/result/error summaries.

### Replay vs continuation

Replay should rebuild durable state and trace, not re-execute effects by accident.

Continuation should resume a known suspended work item, re-minting live handles from serialized descriptors/scope IDs.

The distinction:

- **Replay:** "Given events 1..N, what is the codemode session state?" Pure reduction. It can rebuild provider registry, execution status, pending calls, open waits, and latest checkpoints.
- **Continuation:** "This execution has pending work after event N. Resume exactly that work." This needs a workflow instance or a runner cursor, plus idempotent derived appends.

Do not make event replay call provider APIs. Provider/API calls should be caused by a live runner consuming pending requested events, protected by idempotency and a durable "accepted/started" claim.

### Workflow instance is not the audit log

Cloudflare Workflows are a good durable execution substrate, but instance state/logs expire after retention. The stream must remain the canonical history.

Use Workflows for:

- sleeps beyond a DO alarm's practical window;
- human/webhook waits;
- step-level retries;
- replacing one long open RPC with many durable resumptions;
- dynamic tenant/user script execution via Dynamic Workflows when available.

Do not use Workflows as:

- the only trace visible to users;
- the only record of cancellation;
- the only store of step outputs that matter after 30 days;
- a place to persist live handles.

## Candidate event schemas

The repo currently uses `events.iterate.com/...` short URL-ish strings without `https://`. Existing contracts use `script-execution-completed` with a union outcome. For new hardening, prefer splitting lifecycle edges where the distinction affects traceability, while keeping a `completed` union for APIs that need compact state.

### Script execution lifecycle

```ts
type ScriptExecutionRequested = {
  type: "events.iterate.com/codemode/script-execution-requested";
  payload: {
    scriptExecutionId: string;
    codeRef?: { type: "inline"; code: string } | { type: "artifact"; key: string; sha256: string };
    code?: string; // transitional, current shape
    requestedBy?: { userId?: string; principalId?: string; source: "browser" | "mcp" | "api" };
    streamPath: string;
    providerScopeId?: string;
    limits?: {
      deadlineMs?: number;
      maxFunctionCalls?: number;
      maxCallDepth?: number;
      maxOutputBytes?: number;
    };
  };
};

type ScriptExecutionAccepted = {
  type: "events.iterate.com/codemode/script-execution-accepted";
  payload: {
    scriptExecutionId: string;
    runner: {
      kind: "dynamic-worker" | "cloudflare-workflow" | "dynamic-workflow";
      runId: string;
      workflowName?: string;
      workflowInstanceId?: string;
      workerLoaderId?: string;
    };
    acceptedFromOffset: number;
  };
};

type ScriptExecutionCheckpointed = {
  type: "events.iterate.com/codemode/script-execution-checkpointed";
  payload: {
    scriptExecutionId: string;
    runId: string;
    checkpointId: string;
    afterOffset: number;
    stateRef: { type: "workflow-instance" | "r2-object" | "stream-state"; key: string };
    openWork?: Array<{ kind: "function-call" | "event-wait" | "sleep"; id: string }>;
  };
};

type ScriptExecutionSuspended = {
  type: "events.iterate.com/codemode/script-execution-suspended";
  payload: {
    scriptExecutionId: string;
    runId: string;
    reason: "sleep" | "wait-for-event" | "waiting-for-function-call" | "paused" | "backoff";
    resumeAfter?: string;
    waitingFor?: Array<{ type: string; correlationId?: string; timeoutAt?: string }>;
  };
};

type ScriptExecutionResumed = {
  type: "events.iterate.com/codemode/script-execution-resumed";
  payload: {
    scriptExecutionId: string;
    runId: string;
    trigger:
      | { type: "event"; eventOffset: number; eventType: string }
      | { type: "timer"; scheduledFor: string }
      | { type: "manual"; principalId?: string }
      | { type: "retry"; attempt: number };
    resumedFromCheckpointId?: string;
  };
};

type ScriptExecutionCompleted = {
  type: "events.iterate.com/codemode/script-execution-completed";
  payload: {
    scriptExecutionId: string;
    runId?: string;
    durationMs?: number;
    outcome: { status: "succeeded"; output?: unknown; outputRef?: ArtifactRef };
  };
};

type ScriptExecutionFailed = {
  type: "events.iterate.com/codemode/script-execution-failed";
  payload: {
    scriptExecutionId: string;
    runId?: string;
    durationMs?: number;
    error: SerializedError;
    retryable?: boolean;
    failedStepId?: string;
  };
};

type ScriptExecutionCancellationRequested = {
  type: "events.iterate.com/codemode/script-execution-cancellation-requested";
  payload: {
    scriptExecutionId: string;
    reason?: string;
    requestedBy?: { principalId?: string; source: "browser" | "mcp" | "api" | "system" };
  };
};

type ScriptExecutionCancelled = {
  type: "events.iterate.com/codemode/script-execution-cancelled";
  payload: {
    scriptExecutionId: string;
    runId?: string;
    cancelledFromState: "queued" | "running" | "waiting" | "paused";
    reason?: string;
  };
};
```

Pros:

- Clear UI trace: requested, accepted, suspended, resumed, terminal.
- Clean replay: pending executions are those requested/accepted but not terminal.
- Works with Workflow API lifecycle: `pause`, `resume`, `terminate`, `sendEvent`.
- Keeps Workflow retention from deleting the canonical trace.

Cons:

- More event types than the current compact contract.
- Requires a reducer to collapse many lifecycle events into one execution view.
- `checkpointed` risks becoming a dump if not limited to references and cursors.

### Function/tool call lifecycle

```ts
type FunctionCallRequested = {
  type: "events.iterate.com/codemode/function-call-requested";
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    parentFunctionCallId?: string;
    path: string[];
    input?: unknown;
    inputRef?: ArtifactRef;
    scopeId?: string;
    providerHandleId?: string;
    callDepth?: number;
    timeoutAt?: string;
  };
};

type FunctionCallAccepted = {
  type: "events.iterate.com/codemode/function-call-accepted";
  payload: {
    functionCallId: string;
    acceptedBy: {
      kind: "provider-bridge" | "stream-processor" | "workflow-step";
      id: string;
    };
  };
};

type FunctionCallCompleted = {
  type: "events.iterate.com/codemode/function-call-completed";
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    path: string[];
    durationMs?: number;
    outcome:
      | { status: "succeeded"; output?: unknown; outputRef?: ArtifactRef }
      | { status: "failed"; error: SerializedError; retryable?: boolean };
  };
};

type FunctionCallCancellationRequested = {
  type: "events.iterate.com/codemode/function-call-cancellation-requested";
  payload: {
    functionCallId: string;
    reason?: string;
  };
};

type FunctionCallCancelled = {
  type: "events.iterate.com/codemode/function-call-cancelled";
  payload: {
    functionCallId: string;
    reason?: string;
  };
};
```

Pros:

- Preserves provider-to-provider traceability using `parentFunctionCallId`.
- Allows a provider to accept a call before doing long work.
- Can model external async APIs: request, accepted, suspended/waiting, completed.
- `providerHandleId` and `scopeId` let resumed work re-mint live handles without logging the handles.

Cons:

- A separate `accepted` fact may be unnecessary for synchronous providers.
- Cancellation is cooperative unless the live provider/runtime observes it.
- Inputs/outputs need size policy and artifact references to avoid 1 MiB limits.

### Live capability and handle ledger

```ts
type ProviderRegistered = {
  type: "events.iterate.com/codemode/tool-provider-registered";
  payload: {
    path: string[];
    providerId: string;
    descriptor: SerializableProviderDescriptor;
    docs: string;
    instructions?: string;
    typeDefinitions?: string;
  };
};

type CapabilityHandleMinted = {
  type: "events.iterate.com/codemode/capability-handle-minted";
  payload: {
    handleId: string;
    scriptExecutionId?: string;
    scopeId: string;
    kind: "codemode-session" | "tool-provider" | "logger" | "stream";
    descriptorRef:
      | { type: "provider"; providerId: string }
      | { type: "session"; streamPath: string }
      | { type: "well-known"; name: string };
    expiresAt?: string;
    permissions?: string[];
  };
};

type CapabilityHandleRevoked = {
  type: "events.iterate.com/codemode/capability-handle-revoked";
  payload: {
    handleId: string;
    reason: "cancelled" | "expired" | "scope-revoked" | "completed";
  };
};
```

Pros:

- Keeps traceability for live authority without pretending handles are durable.
- Supports least authority: resumed code asks the session to re-mint handles from `scopeId`.
- Gives cancellation/completion a visible revocation story.

Cons:

- Handle events can create noise if every tiny callback is logged.
- A handle ledger is not useful until scopes/permissions are enforced.
- Need clear vocabulary: a `handleId` is an audit/correlation ID, not a callable address.

### Workflow runner lifecycle

```ts
type WorkflowInstanceCreated = {
  type: "events.iterate.com/codemode/workflow-instance-created";
  payload: {
    scriptExecutionId: string;
    runId: string;
    workflow: {
      kind: "cloudflare-workflow" | "dynamic-workflow";
      name: string;
      instanceId: string;
      versionId?: string;
    };
    paramsRef?: ArtifactRef;
  };
};

type WorkflowEventSent = {
  type: "events.iterate.com/codemode/workflow-event-sent";
  payload: {
    scriptExecutionId: string;
    runId: string;
    workflowInstanceId: string;
    eventType: string;
    sourceEventOffset: number;
  };
};

type WorkflowInstanceTerminated = {
  type: "events.iterate.com/codemode/workflow-instance-terminated";
  payload: {
    scriptExecutionId: string;
    runId: string;
    workflowInstanceId: string;
    reason?: string;
  };
};
```

Pros:

- Makes the external runner observable from the stream.
- Lets operators correlate stream events with Cloudflare Workflows dashboard/API.
- Supports migration between one-shot, Workflow, and Dynamic Workflow runners.

Cons:

- Leaks Cloudflare implementation details into codemode events unless kept behind `runner.kind`.
- Could be redundant with `script-execution-accepted` if the runner object is enough.

Shared helper types:

```ts
type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
};

type ArtifactRef = {
  store: "r2" | "stream" | "d1" | "external";
  key: string;
  sha256?: string;
  contentType?: string;
  byteLength?: number;
};
```

## Runner options

### Option A: Continue current one-shot Dynamic Worker executor

Shape:

- `script-execution-requested` triggers `CodemodeSession.afterAppend`.
- Session loads a Dynamic Worker and awaits `evaluate(...)`.
- Dynamic Worker calls back through `CodemodeSessionCapabilityTarget`.
- Completion is appended by the processor.

Pros:

- Minimal change.
- Strong sandbox story.
- Good for short scripts, examples, and browser REPL blocks.
- Cap'n Web capability passing remains simple.

Cons:

- Not durable across a weeks-long wait.
- A waiting function call currently depends on stream subscription that is not implemented in production `processorStreamApiFromNamespace`.
- Long execution is tied to a live DO/RPC call and dynamic worker lifetime.
- Hard to pause/resume/terminate cleanly.

Use for:

- short scripts;
- demos;
- provider description/introspection;
- immediate computations that finish within one execution turn.

### Option B: Cloudflare Workflow per script execution

Shape:

- `CodemodeSession` appends `script-execution-requested`.
- A runner appends `script-execution-accepted` and creates a Workflow instance with `id = scriptExecutionId` or `runId`.
- Workflow `run()` executes durable steps:
  - load script/code ref;
  - run code until it requests a function call or wait;
  - append request events;
  - `waitForEvent()` or sleep until completion/resume/cancel;
  - append terminal events.
- External provider completions are bridged into `instance.sendEvent(...)` and also remain stream events.

Pros:

- Durable steps, retries, sleep, waitForEvent, pause/resume/terminate are platform features.
- Waiting instances do not count toward concurrency limits.
- Avoids one long live DO RPC.
- Maps cleanly to weeks-long scripts and human-in-the-loop flows.

Cons:

- Requires code to be structured around durable steps; arbitrary JS stack frames are not magically serializable.
- Workflow output/state/logs expire after retention, so stream must remain source of truth.
- Step result/event payload limits require artifact references.
- Need idempotency around Workflow create/restart and stream appends.

Use for:

- scripts that can suspend;
- long provider operations;
- approval/webhook waits;
- scheduled/resumable agent work.

### Option C: Dynamic Workflows for user/tenant-authored workflow code

Shape:

- Worker Loader loads the user/tenant Dynamic Worker.
- `@cloudflare/dynamic-workflows` tags Workflow instances with metadata and reloads the same Dynamic Worker on resume.
- The dynamic workflow code uses `step.do`, `step.sleep`, and `step.waitForEvent`.

Pros:

- Closest fit to "agent writes durable workflow plan at runtime".
- Cloudflare handles reloading dynamic code on resume.
- Avoids registering every user workflow class up front.

Cons:

- Newer surface as of May 2026; likely more operational unknowns.
- Requires codemode to compile/generated code into Workflow-shaped code, not just `async (ctx) => ...`.
- Needs source/version pinning so a resumed instance uses the intended code.

Use for:

- planned codemode "scripts" that are really workflows;
- tenant/project-defined automations;
- long-running generated plans.

### Option D: Custom DO scheduler/outbox

Shape:

- `CodemodeSession` stores pending work in DO storage and uses alarms/outbox events.
- Each continuation consumes stream offsets and pending operation records.

Pros:

- Full control over event sourcing semantics.
- Can stay inside current stream/DO architecture.
- No Workflow retention mismatch.

Cons:

- Rebuilds Workflows badly: retries, sleeps, waitForEvent, pause/resume, observability, rate limits.
- DO alarms have wall-time invocation limits and hibernation/eviction realities.
- Harder to make weeks-long correctness boring.

Use for:

- small local schedulers;
- cleanup/outbox dispatch;
- glue around stream events;
- not the primary weeks-long codemode runner.

## Proposed trajectory

### Phase 1: Harden event semantics without changing execution substrate

- Add `script-execution-accepted` or `script-execution-started` before launching the executor.
- Split terminal failures into `script-execution-failed` or keep current `script-execution-completed` union but add a reducer-compatible migration path.
- Add `function-call-accepted` only when a provider can genuinely claim a call before completion.
- Add `parentFunctionCallId`, `callDepth`, and `scopeId` to function call requests.
- Add cancellation request/cancelled events and have the current executor observe local aborts where possible.
- Store large code/results behind refs, not inline, once size is non-trivial.

### Phase 2: Make waits durable

- Replace `waitForFunctionCallResult()` subscription dependence with an explicit pending-call state machine.
- A provider completion append should wake the `CodemodeSession` or Workflow runner.
- The runner should re-read from the stream offset, match pending IDs, and continue.
- For one-shot Dynamic Worker mode, reject or fail gracefully if a script attempts a wait that cannot be satisfied in the current turn.

### Phase 3: Introduce `CodemodeWorkflowRunner`

Interface sketch:

```ts
type CodemodeWorkflowRunner = {
  acceptScript(input: {
    requestEvent: Event;
    streamPath: string;
    projectId: string;
    codeRef: CodeRef;
    providerScopeId: string;
  }): Promise<{
    runId: string;
    runnerKind: "dynamic-worker" | "cloudflare-workflow" | "dynamic-workflow";
    workflowInstanceId?: string;
  }>;

  deliverEvent(input: { runId: string; event: Event }): Promise<void>;

  cancel(input: { runId: string; reason?: string }): Promise<void>;
};
```

The stream remains the input/output channel. `deliverEvent()` is an optimization for Workflow `sendEvent`, not the source of truth.

### Phase 4: Dynamic Workflow script model

- Add a second script authoring target: `async function run(ctx, step)`.
- Generate or require step names to be stable.
- Persist code version/hash in `script-execution-requested`.
- Use `step.do()` only around idempotent or idempotency-keyed work.
- Use `step.waitForEvent()` for external completions and human approvals.
- Recreate live Cap'n Web handles inside each step from descriptors/scope IDs.

## Non-serializable live handles without trace loss

Rule: every live handle must have a serializable audit shadow.

Example:

1. Session creates a scoped logger `RpcTarget` and provider broker `RpcTarget`.
2. Before passing them to a Dynamic Worker/Workflow step, append or include in accepted metadata:
   - `scopeId`
   - `handleId`
   - `kind`
   - permissions
   - descriptor refs
3. The live object is passed over Workers RPC only to the current isolate.
4. If the isolate dies or a Workflow resumes later, the runner asks `CodemodeSession` to mint fresh live facades for the same `scopeId`.
5. Event trace shows which authority existed and why, without ever storing the unforgeable stub.

This follows Kenton's object-capability framing: possession of the stub is authority. The event log should record that the session minted authority under a scope, but possession itself stays in the RPC graph.

## Open design questions

- Should the canonical terminal model be one union event (`script-execution-completed` with `outcome`) or split `succeeded`/`failed`/`cancelled` facts? Split facts are clearer for trace/UI; union is simpler for current reducers.
- Should `scriptExecutionId` be generated at request time forever, or should request offset become the primary identity? Current code uses IDs; keep IDs because offsets are stream-local and less portable across Workflow/API boundaries.
- Should Cloudflare Workflow instance ID equal `scriptExecutionId`? Good for lookup/idempotency, but a separate `runId` is better when retrying/restarting the same script execution.
- What is the first stable `scopeId` schema for least-authority provider access?
- Are provider descriptors trusted at registration time, or validated lazily per call against the dispatch context?
- Should Dynamic Workflow support require a different user-code shape, or should codemode compile `async (ctx) => ...` into a workflow state machine?

## Recommendation

Adopt the three-plane model now:

- **Stream events are the product-visible trace and canonical replay state.**
- **Workflows are durable continuation machinery for long-running scripts, with all important state mirrored as stream facts or artifact refs.**
- **Cap'n Web/Workers RPC capabilities are live handles scoped to one active execution, re-minted from serializable descriptors after resume.**

In the near term, harden event schemas and pending-work state before replacing the executor. Then add a Workflow-backed runner behind the same codemode session API. This keeps the current vertical slice useful while preventing the architecture from depending on non-durable JS stack frames or serialized live capabilities.
