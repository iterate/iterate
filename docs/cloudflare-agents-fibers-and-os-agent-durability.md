# Cloudflare Agents Fibers and OS Agent Processor Durability

Date: 2026-07-09

This note captures what I found about the Cloudflare Agents fiber system and how a similar idea could apply to `apps/os` agent processors.

## Source Snapshot

Cloudflare Agents:

- Repository: `/Users/jonastemplestein/src/github.com/cloudflare/agents`
- Remote: `https://github.com/cloudflare/agents`
- Branch: `main`
- Commit reviewed: `d1cc31751687`
- Main files:
  - `packages/agents/src/index.ts`
  - `packages/think/src/think.ts`
  - `packages/agents/src/chat/resumable-stream.ts`
  - `packages/agents/src/chat/resume-handshake.ts`

Iterate OS:

- Repository: `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum`
- Commit reviewed: `1c87225503ec`
- Main files:
  - `apps/os/src/domains/streams/stream-processor.ts`
  - `apps/os/src/domains/streams/stream-processor-host.ts`
  - `apps/os/src/domains/agents/agent-processor-implementation.ts`
  - `apps/os/src/domains/agents/cloudflare-ai-processor-implementation.ts`
  - `apps/os/src/domains/agents/openai-ws-processor-implementation.ts`
  - `apps/os/src/domains/capability-host/capability-host-processor-implementation.ts`

## Short Answer

Cloudflare Agents fibers are a durable async job ledger for Durable Objects. They are not true VM continuations and they do not resume JavaScript at the exact suspended stack frame.

The system does this:

1. Insert a durable row before async work starts.
2. Hold a DO keepalive while work runs.
3. Let the work checkpoint small JSON snapshots with `stash()`.
4. Delete or terminalize the row on completion.
5. If the DO dies, recover by scanning leftover rows and calling a recovery hook.

We can use a similar pattern in OS, but it should be implemented as an OS stream-processor task primitive rather than copied directly. OS streams should remain the source of truth. Fiber-like rows should be operational leases/recovery hints for long-running side effects.

## What Cloudflare Means by Fiber

The core public type is `FiberContext`:

- `id`: unique execution ID.
- `signal`: cooperative cancellation signal.
- `stash(data)`: synchronous SQLite checkpoint write.
- `snapshot`: currently `null` during live execution; recovery receives the last stashed snapshot.

The public statuses are:

- `pending`
- `running`
- `completed`
- `aborted`
- `interrupted`
- `error`

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:732`

The important conceptual point is that `stash()` is not a continuation. It is application-defined recovery state. If a fiber dies after stashing `{ phase: "sent_request" }`, recovery receives that JSON and must decide what to do.

## The Two Fiber Tables

Cloudflare keeps two related structures.

### `cf_agents_runs`

This is the lightweight in-flight row used by `runFiber()`.

Fields:

- `id`
- `name`
- `snapshot`
- `created_at`

It is inserted before execution and deleted when execution exits. If the DO dies, the row remains and marks interrupted work.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:2078`

### `cf_agents_fibers`

This is the managed fiber/job ledger used by `startFiber()`.

Fields:

- `fiber_id`
- `idempotency_key`
- `name`
- `status`
- `snapshot`
- `metadata_json`
- `error_message`
- `created_at`
- `started_at`
- `completed_at`

It adds idempotent acceptance, inspection, cancellation, terminal status, and cleanup.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:2107`

## `keepAlive()`

`keepAlive()` is the liveness half of the design. It increments an in-memory reference count and schedules the DO alarm so the object is woken periodically while work is active.

Important details:

- Default heartbeat is controlled by `keepAliveIntervalMs`.
- Lower interval means faster recovery after eviction but more alarms.
- `keepAliveWhile(fn)` wraps acquisition/release in `try/finally`.
- In sub-agent facets, keepalive delegates to the root alarm owner because facets do not own independent alarms.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:4678`

This is stronger than `ctx.waitUntil()` alone. `waitUntil()` can keep work alive after a request returns, but a durable alarm is what lets the object wake later and notice incomplete work.

## `runFiber()`

The unmanaged fiber path is:

1. Generate fiber ID.
2. Insert into `cf_agents_runs`.
3. Add ID to in-memory active set.
4. Optionally write initial snapshot.
5. If this is a facet, register the run with the root.
6. Acquire `keepAlive()`.
7. Run callback inside AsyncLocalStorage so `this.stash()` can find the current fiber.
8. On success, emit observability and return the result.
9. On error, emit observability and rethrow.
10. In `finally`, remove active ID, delete `cf_agents_runs` row, release keepalive, and unregister facet run.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5291`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5486`

The key invariant is: row exists while work may need recovery. Row deletion means there is nothing left to recover.

## `startFiber()`

`startFiber()` is the managed job API layered on top of `runFiber()`.

It adds:

- caller-provided `fiberId`
- optional `idempotencyKey`
- optional metadata
- optional wait-for-completion behavior
- `pending -> running -> terminal` status changes
- inspection result shape
- duplicate acceptance collapse

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5330`

This is closer to what OS should copy for agent processors, because OS wants idempotent externally visible work rather than just a private `try/finally` wrapper.

## Recovery

Recovery scans happen in `_checkRunFibers()`.

The scan:

1. Reads rows from `cf_agents_runs`.
2. Skips IDs that are active in the current incarnation.
3. Parses the stored snapshot.
4. Builds a `FiberRecoveryContext`.
5. Emits recovery observability.
6. If the row has a managed ledger entry, marks it `interrupted`.
7. Calls `_runFiberRecoveryHook()`.
8. Deletes unmanaged rows only if recovery handled them or they exceeded max age.
9. For managed rows, notifies waiters and records terminal state.
10. Separately scans `cf_agents_fibers` rows that are `pending/running` but have no run row.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5624`

The default user hook is `onFiberRecovered(ctx)`.

Source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5602`

Think subclasses use internal hooks to recover chat turns, submissions, stream responses, and agent-tool children before exposing generic recovery to user code.

## Recovery Is Application Logic

The fiber runtime does not know how to safely resume arbitrary work. It only tells the application:

- this work was probably interrupted
- here is its ID
- here is its name
- here is its idempotency key
- here is its metadata
- here is the latest stashed JSON snapshot
- here is when it started

The application must decide whether to:

- retry the work
- inspect an external operation
- append a failure event
- mark as interrupted
- terminalize after too many attempts
- do nothing because another path completed it

This is why Think's real durability comes from the combination of fibers plus chat-specific ledgers: turns, stream buffers, settled tool results, action ledgers, child-agent runs, and recovery budgets.

## Important Design Lessons from Think

The issue/PR history around Think shows the fiber primitive alone is not enough. Durable agents also need:

- Stable turn IDs.
- Stable assistant message IDs.
- Stable tool-call IDs.
- Durable settled tool results.
- Durable stream/chunk buffers if token replay matters.
- Recovery attempt budgets.
- OOM crash-loop sealing.
- Bounded output ingestion.
- Idempotent external delivery.
- Parent/child run progress ledgers.
- Per-turn immutable external context.

Open or recent Think issues that informed this:

- `https://github.com/cloudflare/agents/issues/1876` - duplicate assistant message after continuation recovery.
- `https://github.com/cloudflare/agents/issues/1870` - unbounded exec output OOMs and bricks a session.
- `https://github.com/cloudflare/agents/issues/1877` - scheduled tasks duplicated on facets.
- `https://github.com/cloudflare/agents/issues/1894` - ambient messenger context can race across concurrent turns.
- `https://github.com/cloudflare/agents/issues/1676` - need first-class events/render-only messages/typed metadata.
- `https://github.com/cloudflare/agents/issues/1681` - persisted stream chunks have cost but are tied to recovery guarantees.

## How OS Stream Processors Work Today

OS already has a strong durability model for stream processing.

`StreamProcessor.ingest()`:

1. Loads the last durable checkpoint.
2. Filters already processed events.
3. Reduces new events into state.
4. Runs `processEventBatch()`.
5. Awaits all `blockProcessorWhile()` work.
6. Writes `{ offset, state }` checkpoint.
7. Advances in-memory state.
8. Resolves waiters.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:288`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:533`

This gives OS one important property Think fibers do not provide by themselves:

- If blocking work fails before checkpoint, the stream batch is replayed.

That means `blockProcessorWhile()` is already durable in the stream sense. It should be used for short, bounded, idempotent work that must complete before the checkpoint advances.

## The Gap: `runInBackground()`

The gap is fire-and-forget work.

`runInBackground()` uses host keepalive/waitUntil and logs errors, but the processor checkpoint can advance while the work is still running.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:499`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:631`

The processor host currently passes:

```ts
keepAliveWhile: (work) => void ctx.waitUntil(work());
```

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor-host.ts:344`

That keeps a request alive, but it does not create a durable task row or alarm-backed recovery sweep. If the DO dies after the checkpoint advances, the original event will not be redelivered. The background task must have its own recovery plan.

This is exactly the kind of work a fiber-like primitive would help with.

## Existing OS Precedent: OpenAI WebSocket Processor

`OpenAiWsProcessor` already hand-rolls a domain-specific fiber-ish pattern.

It records request lifecycle in reduced state:

- `requested`
- `started`
- `completed`

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-contract.ts:13`

It keeps an in-memory `#liveExecutions` set for the current DO incarnation.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:90`

After every batch, it fails requests that durable state says are incomplete but that no live execution owns.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:152`

Its completion path uses identical idempotency keys for normal completion and orphan recovery, so races collapse to one durable outcome.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:269`

This is the best local proof that OS wants a reusable durable-task abstraction. The pattern is correct but should not be reimplemented per processor.

## Existing OS Gap: Cloudflare AI Processor

`CloudflareAiProcessor` runs LLM requests in background work and appends provider chunks/completion.

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/cloudflare-ai-processor-implementation.ts:51`

Its contract only tracks:

- `started`
- `completed`

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/cloudflare-ai-processor-contract.ts:9`

Unlike OpenAI WS, it does not mark the request as `requested` in provider state before execution and does not have an orphan sweep. If a DO incarnation dies after the agent stream checkpoint advances but before provider completion lands, the agent can wedge behind a request that never completes.

This should be fixed either directly or as the first consumer of a durable-task primitive.

## Existing OS Script Execution Pattern

Capability-host script execution is journaled:

- `script-execution-requested`
- run dynamic worker
- `script-execution-completed`

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:376`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:405`

This is close to the correct event model. A fiber-like task wrapper would improve long-running script safety by adding:

- task row before execution
- alarm-backed recovery
- explicit interrupted status
- bounded result/log snapshots
- retry/terminalization policy

## Should We Make the Whole Agent Processor Durable?

No. The whole `AgentProcessor` should not become a fiber.

The stream processor is already durable at the event/checkpoint level. Wrapping the whole processor loop in a fiber would mix two durability models and make replay semantics harder to reason about.

Instead, make the fragile async side effects durable:

- LLM request execution.
- Model stream consumption.
- Dynamic script execution.
- Sandbox commands.
- Workspace/repo operations that may take a while.
- External delivery side effects where duplicates matter.
- Child agent runs.

The processor should keep doing what it does well:

- fold stream events
- decide what side effects are needed
- append requested/completed/failed facts
- checkpoint only after bounded blocking work

The durable-task layer should own:

- background work lifecycle
- keepalive/alarm
- orphan detection
- recovery hooks
- retry/terminalization budgets
- inspection

## Proposed OS Primitive: Durable Processor Tasks

Add an OS-native helper, roughly:

```ts
runDurableTask({
  processorSlug,
  taskId,
  kind,
  idempotencyKey,
  sourceOffset,
  metadata,
  run,
  recover,
});
```

The exact API should be TypeScript-safe and probably exposed through processor deps, not a global import.

### Storage

Use DO storage SQL if available on the host, or KV if we want to keep it smaller initially. SQL is better for scans and indexes.

Table sketch:

```sql
CREATE TABLE IF NOT EXISTS os_processor_tasks (
  task_id TEXT PRIMARY KEY,
  processor_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL,
  source_offset INTEGER,
  snapshot TEXT,
  metadata_json TEXT,
  error_message TEXT,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_processor_tasks_status_updated
ON os_processor_tasks(status, updated_at, task_id);

CREATE INDEX IF NOT EXISTS idx_processor_tasks_processor_status
ON os_processor_tasks(processor_slug, status, updated_at, task_id);
```

Statuses:

- `pending`
- `running`
- `completed`
- `failed`
- `interrupted`
- `aborted`
- `terminal`

### Runtime Behavior

On start:

1. Insert task row with `pending`.
2. If existing row with same idempotency key exists, return it.
3. Mark `running`.
4. Register task ID in in-memory active set.
5. Acquire alarm-backed keepalive.
6. Run callback with `{ taskId, signal, stash }`.
7. On completion, mark `completed` and append domain completion event.
8. On failure, mark `failed` or append domain failure event.
9. Remove active set entry.
10. Release keepalive.

On stash:

1. JSON serialize small snapshot.
2. Cap snapshot size.
3. Write to task row.
4. Optionally update `updated_at`.

On recovery:

1. Wake via alarm or configured stream subscriber wake.
2. Scan non-terminal tasks where `task_id` is not in active set.
3. Mark `interrupted`.
4. Call processor-specific recovery hook.
5. Hook can append failure/completion/interrupted events.
6. Increment recovery attempts.
7. Terminalize after max attempts or max age.

### Processor Hook Shape

Each processor that uses durable tasks should be able to define:

```ts
recoverDurableTask(task: DurableProcessorTask): Promise<DurableTaskRecoveryResult>
```

Recovery result:

- `completed`
- `failed`
- `retry`
- `interrupted`
- `terminal`
- `ignored`

Most OS processors should prefer appending stream events over retrying opaque JS. Recovery should be event-first.

## How This Maps to OS Agent Work

### LLM Requests

For each `agent/llm-request-requested` event:

- Durable task ID: `llm:${provider}:${llmRequestId}`
- Source offset: `llmRequestId`
- Idempotency key: provider-specific completion key
- Metadata: model, provider, request generation
- Snapshot: last streamed sequence, accumulated text preview, provider response ID if available

Recovery:

- If completion event already exists, mark completed.
- If provider has resumable/retrievable run, inspect it.
- If not inspectable, append `agent/llm-request-completed` failure with a recovery message.
- If chunks exist but no final completion, either complete from accumulated chunks if safe or fail with interrupted status.

### Script Execution

For each `capability-host/script-execution-requested` event:

- Durable task ID: `script:${executionId}`
- Source offset: requested event offset
- Metadata: scope path, code hash
- Snapshot: current phase only, not full output

Recovery:

- If completion event exists, mark completed.
- If dynamic worker execution cannot be inspected, append failure completion saying execution was interrupted.
- Never silently re-run scripts unless the script is explicitly declared idempotent.

### Sandbox Commands

For each sandbox command:

- Durable task ID: `sandbox-command:${sandboxId}:${commandId}`
- Snapshot: last output byte offset, exit status if known
- Full output: external pointer, not task row or stream payload

Recovery:

- Inspect container/process if possible.
- Otherwise append interrupted/failed event with log pointer.

This directly addresses Cloudflare issue #1870: never persist unbounded command output in DO rows or stream events.

### External Delivery

For Slack/email/GitHub replies:

- Durable task ID includes provider and external thread/message/comment ID.
- Snapshot includes provider delivery ID after first post/edit.
- Recovery checks existing provider delivery ID before sending again.

This prevents duplicate replies after DO death.

## KeepAlive and Alarms in OS

Today `stream-processor-host.ts` uses:

```ts
keepAliveWhile: (work) => void ctx.waitUntil(work());
```

Source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor-host.ts:344`

A fiber-like OS primitive needs alarm-backed recovery, not only `waitUntil`.

Options:

1. Add alarm handling to every DO that hosts processors.
2. Add a root/root-like task owner per stream host.
3. Add a generic processor task host that can be embedded in DOs and exposes `alarm()`.

Option 3 is probably the cleanest. Something like:

- `createDurableTaskHost(ctx, { namespace, recover })`
- processor host gets task APIs from it
- DO `alarm()` delegates to task host and scheduler-like processors if present

But we need to be careful because some DOs already use alarms, for example scheduler DOs. Cloudflare DOs have one alarm slot, so shared alarm ownership must be explicit.

## Interaction With Stream Checkpoints

This is the most important design boundary.

`blockProcessorWhile()`:

- Use for bounded work that must finish before checkpoint.
- If it fails, the event batch replays.
- No task row needed for simple appends/projections.

`runInBackground()`:

- Use only when the work has its own durable task row or is best-effort.
- If it matters, it must append a terminal stream event.
- If it has external side effects, it must have an idempotency key and recovery policy.

Proposed rule:

> Any `runInBackground()` path that can leave the agent waiting on a future event must use durable tasks or prove it has an equivalent orphan sweep.

OpenAI WS currently has an equivalent orphan sweep. Cloudflare AI does not.

## Why Not Just Use Cloudflare Agents `runFiber()`?

Reasons not to directly import/use it as-is:

1. It is coupled to Cloudflare's `Agent` base class.
2. OS processors are not `Agent` subclasses.
3. OS already has a stream/checkpoint model that should remain authoritative.
4. Think's fiber API assumes class hooks like `onFiberRecovered`.
5. OS needs per-processor, per-stream, per-project recovery semantics.
6. OS needs stream event append as the recovery output, not arbitrary callback resumption.

We should copy the pattern, not the implementation.

## Minimal First Implementation

The smallest useful OS version:

1. Add `DurableTaskHost` utility under `apps/os/src/domains/streams` or `apps/os/src/domains/durable-tasks`.
2. Back it with DO storage SQL.
3. Expose `runDurableTask()` through hosted processor deps.
4. Add `recoverDurableTasks()` and wire it to an alarm in `AgentDurableObject`.
5. Convert `CloudflareAiProcessor` to use it.
6. Add tests for DO restart/orphan by simulating active task loss.

Why start with Cloudflare AI:

- It is simpler than OpenAI WS.
- It currently lacks the OpenAI WS orphan sweep.
- It exercises model streaming, chunk appends, success, failure, and interrupted recovery.

Expected behavior after conversion:

- A request that dies mid-run no longer wedges `currentRequest`.
- Recovery appends `agent/llm-request-completed` failure or terminal interrupted event.
- Idempotency keys collapse races with late completions.
- Dashboard can inspect task status.

## Test Cases We Should Add

For the durable task primitive:

- Starts new task and records row before running callback.
- Duplicate idempotency key returns existing task.
- `stash()` updates snapshot.
- Successful task terminalizes and clears active lease.
- Failed task records error and terminal status.
- Recovery sees row with no active owner.
- Recovery skips row owned by current incarnation.
- Recovery terminalizes after max attempts.
- Recovery obeys max age.
- Alarm is scheduled while non-terminal tasks exist.
- Alarm backs off on no progress.

For `CloudflareAiProcessor`:

- Dies after request accepted but before started event.
- Dies after started event but before completion.
- Dies after some chunks but before completion.
- Late live completion races recovery failure; idempotency leaves one outcome.
- Request no longer wedges `AgentProcessor.currentRequest`.

For script execution:

- Dies after `script-execution-requested`.
- Recovery appends interrupted completion.
- Non-idempotent scripts are not re-run by default.
- Huge result/log is truncated and externalized.

For delivery:

- Dies after provider post succeeds but before stream delivery event.
- Recovery uses stored provider message ID instead of posting again.

## Risks

### Mixing Task Rows and Stream Events

If task rows become authoritative, we will weaken OS's stream model. The rule should be strict: task rows are operational; stream events are facts.

### Retrying Non-Idempotent Work

Recovery must not blindly retry scripts or external delivery. It should inspect, append interrupted, or use provider idempotency.

### One Alarm Slot

Each DO has one alarm. A durable task host must coordinate with existing alarm users.

### Snapshot Size

`stash()` snapshots must be capped. Large output belongs in external storage with pointers.

### Poison Recovery

A recovery hook that always throws can wake the DO forever. Need attempt limits, max age, and backoff.

### Facet/Owner Ambiguity

Think hit schedule duplication on facets. OS should make task owner explicit: project ID, stream path, processor slug, task kind.

## Recommended Design Decision

Build an OS-native durable task primitive for stream processors.

Do not wrap the entire agent processor in a fiber. Instead:

- Keep stream events and checkpoints as durable truth.
- Add durable task rows for background async work.
- Require terminal stream events for results that affect agent state.
- Use idempotency keys for every result event.
- Add alarm-backed orphan recovery.
- Convert Cloudflare AI first.
- Later convert script execution, sandbox commands, and external delivery.

This gives us the useful part of Cloudflare's fiber system while preserving the OS architecture.

## Source Links

Cloudflare local source:

- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:732`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:2078`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:4678`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5291`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5330`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5486`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5602`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts:5624`

OS local source:

- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:288`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:499`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:533`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor.ts:631`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/streams/stream-processor-host.ts:344`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/agent-processor-implementation.ts:25`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/cloudflare-ai-processor-contract.ts:9`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/cloudflare-ai-processor-implementation.ts:51`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-contract.ts:13`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:90`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:152`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/agents/openai-ws-processor-implementation.ts:269`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:376`
- `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum/apps/os/src/domains/capability-host/capability-host-processor-implementation.ts:405`

GitHub references:

- `https://github.com/cloudflare/agents/issues/1876`
- `https://github.com/cloudflare/agents/issues/1870`
- `https://github.com/cloudflare/agents/issues/1877`
- `https://github.com/cloudflare/agents/issues/1894`
- `https://github.com/cloudflare/agents/issues/1676`
- `https://github.com/cloudflare/agents/issues/1681`
