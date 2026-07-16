import { tracing } from "cloudflare:workers";
import { StreamProcessor, type ProcessorReads } from "iterate/stream-processor";
import type { JsonValue, StatelessDynamicWorkerRef } from "../workers/schemas.ts";
import type { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import type { ScheduleView } from "./types.ts";
import {
  SchedulerProcessorContract,
  type ScheduleSetPayload,
  type SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";
import {
  barrenWakeAtMs,
  dueSchedules,
  initialTriggerAtMs,
  nextTriggerAtMs,
  nextWakeAtMs,
} from "./recurrence.ts";

/**
 * Runtime dependencies the hosting Durable Object injects. Everything
 * time- or platform-shaped is injected so unit tests run the processor with a
 * fake clock, a spy alarm, and a stub script runner.
 */
export type SchedulerProcessorDeps = {
  /** Script runner; scripts execute at project-root itx scope (see the DO). */
  dynamicWorkers: Pick<DynamicWorkerRunner, "invokeCapability">;
  /** Injectable clock. Only Trigger emission reads it — reduce never does. */
  now: () => number;
  /**
   * Repoint (or, with null, delete) the scheduler's slice of the platform
   * alarm. Called at the head of every delivery (`processEvent` under
   * `delivery.caughtUp`, as a blockProcessorWhile closure) and after every
   * triggerDue(). The at-head await is load-bearing: a failed repoint must
   * fail the frame so the transport redelivers it.
   */
  repointAlarm: (atMs: number | null) => void | Promise<void>;
  /** Next armed alarm time, for runtime-state inspection only. */
  readAlarm: () => Promise<number | null>;
  /**
   * RUNNER-backed reads of the committed fold. Under registry drive the
   * runner owns both cursors and the processor instance's internal checkpoint
   * never advances, so every fold read the scheduler makes OUTSIDE a hook's
   * own args — triggerDue's due/sweep decisions, an execution's
   * latest-code-wins resolution and read-your-writes barrier, the view
   * builders — must go through the runner's committed progress. The hosting
   * DO wires this to `registry.reads(processor)` (lazily — `reads()` needs
   * the registered processor); the unit harness wires it to the driving
   * StreamProcessorRunner.
   */
  reads: Pick<ProcessorReads<SchedulerProcessorState>, "snapshot" | "waitUntilEvent">;
};

/**
 * The Scheduler's stream processor: reduces the four scheduler events into
 * `{ schedules, pendingTriggers }`, launches itx-script executions for
 * pending Triggers, and derives the next Durable Object alarm from state.
 *
 * Execution semantics:
 *
 * - At-least-once per Trigger. `trigger-requested` marks the executionId
 *   pending in reduced state; a Durable Object restart mid-run clears the
 *   in-memory in-flight set, so the next wake's sweep (triggerDue) re-launches
 *   anything still pending. Before invoking, an execution checks the stream
 *   for its completion's idempotency key, so a checkpoint-loss replay cannot
 *   re-run history. Actions must be idempotent per executionId.
 * - Latest-code-wins. The script is resolved from reduced state at execution
 *   time, never snapshotted into the request: a re-set between request and
 *   execution runs the new code, and a cancelled Schedule's in-flight Trigger
 *   completes as `skipped`. `trigger-completed.definedAtOffset` records which
 *   `schedule-set` event's code actually ran.
 * - Completion appends are idempotency-keyed by executionId, so a raced
 *   double-execution still commits exactly one outcome event.
 */
export class SchedulerProcessor extends StreamProcessor<
  typeof SchedulerProcessorContract,
  SchedulerProcessorDeps
> {
  readonly contract = SchedulerProcessorContract;
  /**
   * ExecutionIds currently running in THIS instance. Deliberately not durable:
   * after a restart it is empty, which is exactly the signal that every
   * still-pending Trigger needs re-launching.
   */
  readonly #inflightExecutions = new Set<string>();
  /** Consecutive alarm wakes that made no progress; drives the barren-wake backoff. */
  #consecutiveBarrenWakes = 0;
  /** Checkpoint seen by the previous triggerDue — the progress signal for the backoff. */
  #lastWakeCheckpointOffset: number | null = null;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof SchedulerProcessorContract>["reduce"]>[0] & {
    state: SchedulerProcessorState;
  }): SchedulerProcessorState {
    switch (event.type) {
      case "events.iterate.com/scheduler/created":
        if (state.birthCertificate !== null) {
          throw new Error("scheduler received more than one created event");
        }
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/scheduler/schedule-set": {
        const payload = event.payload;
        return {
          ...state,
          schedules: {
            ...state.schedules,
            [payload.key]: {
              action: payload.action,
              definedAtOffset: event.offset,
              ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
              path: event.path,
              nextTriggerAt: initialTriggerAtMs(payload.recurrence, Date.parse(event.createdAt)),
              recurrence: payload.recurrence,
              runCount: 0,
              setAt: event.createdAt,
            },
          },
        };
      }
      case "events.iterate.com/scheduler/schedule-cancelled": {
        if (!(event.payload.key in state.schedules)) return state;
        const { [event.payload.key]: _cancelled, ...schedules } = state.schedules;
        return { ...state, schedules };
      }
      case "events.iterate.com/scheduler/trigger-requested": {
        const payload = event.payload;
        const pendingTriggers = {
          ...state.pendingTriggers,
          [payload.executionId]: {
            key: payload.key,
            requestedAt: payload.requestedAt,
            runCount: payload.runCount,
            scheduledFor: payload.scheduledFor,
          },
        };
        const entry = state.schedules[payload.key];
        if (entry === undefined) return { ...state, pendingTriggers };
        return {
          ...state,
          pendingTriggers,
          schedules: {
            ...state.schedules,
            [payload.key]: {
              ...entry,
              nextTriggerAt: nextTriggerAtMs(entry.recurrence, Date.parse(event.createdAt)),
              runCount: payload.runCount,
            },
          },
        };
      }
      case "events.iterate.com/scheduler/trigger-completed": {
        const { [event.payload.executionId]: _completed, ...pendingTriggers } =
          state.pendingTriggers;
        const entry = state.schedules[event.payload.key];
        // An exhausted one-shot leaves state once its Trigger settles. A re-set
        // between request and completion has a fresh nextTriggerAt and survives.
        if (entry !== undefined && entry.nextTriggerAt === null && "at" in entry.recurrence) {
          const { [event.payload.key]: _spent, ...schedules } = state.schedules;
          return { ...state, pendingTriggers, schedules };
        }
        return { ...state, pendingTriggers };
      }
      default:
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<typeof SchedulerProcessorContract>["processEvent"]>[0],
  ): undefined {
    if (args.state.birthCertificate === null) return;
    const { event } = args;
    // AT-HEAD alarm derivation (was `onCaughtUp`): fires only when this event
    // was the observed stream head at delivery, so `args.state` is the whole
    // fold. It rides a `blockProcessorWhile` closure, which the runner awaits
    // BEFORE the frame's final commit — the alarm always reflects the fold
    // that is about to be acknowledged, and a failed repoint fails the frame
    // so the transport redelivers it (the await is as load-bearing as the old
    // per-batch repoint's was; a bare synchronous call here would NOT be
    // awaited). Re-arming an unchanged time is a no-op in the registry's
    // slice reconcile, so the every-at-head-frame cadence is cheap.
    if (args.delivery.caughtUp) {
      args.blockProcessorWhileCaughtUp(async () => {
        await this.deps.repointAlarm(nextWakeAtMs(args.state, this.deps.now()));
      });
    }
    if (event.type !== "events.iterate.com/scheduler/trigger-requested") return;
    // No gate here — #execute does all the gating after its barrier: pending
    // recheck against committed state, plus a completion-existence read so a
    // checkpoint-loss replay cannot re-run history. The barrier offset makes
    // the execution wait for this frame's commit (latest-code-wins reads the
    // runner's committed fold via deps.reads).
    this.#launchExecution(event.payload.executionId, event.offset);
  }

  // The processor-contributed runtime bag only — the hosting registry pins
  // the runner's snapshot under it before it leaves over RPC.
  override async getRuntimeState() {
    return {
      runtime: {
        inflightExecutions: [...this.#inflightExecutions],
        nextAlarmAt: await this.deps.readAlarm(),
      },
    };
  }

  /**
   * Request a Trigger for every due Schedule, sweep orphaned pending
   * executions, and re-arm the alarm. The hosting Durable Object calls this
   * from `alarm()` after a catch-up; the appended trigger-requested events
   * flow back through ingestion, which is where executions actually launch.
   */
  async triggerDue(): Promise<{ requested: number }> {
    // Runner-backed self-load: after a restart this can run before any
    // delivery, and the due/sweep decisions below must see the durable
    // committed fold (the runner's load performs any pending refold too).
    const { state } = await this.deps.reads.snapshot();
    assertSchedulerCreated(state);
    const now = this.deps.now();
    const due = dueSchedules(state.schedules, now);
    if (due.length > 0) {
      await this.append(
        ...due.map(([key, entry]) => ({
          type: "events.iterate.com/scheduler/trigger-requested" as const,
          // One request per (schedule incarnation, occurrence): a wake that
          // crashed after appending and re-runs cannot double-trigger, and a
          // later re-set of the same key/occurrence (definedAtOffset differs)
          // can never dedupe against a spent request from a past life.
          idempotencyKey: this.idempotencyKey(
            `trigger-requested:${key}:${entry.definedAtOffset}:${entry.nextTriggerAt}`,
          ),
          payload: {
            executionId: crypto.randomUUID(),
            key,
            requestedAt: new Date(now).toISOString(),
            runCount: entry.runCount + 1,
            scheduledFor: new Date(entry.nextTriggerAt!).toISOString(),
          },
        })),
      );
    }
    // Restart recovery: anything pending that no live execution owns was
    // orphaned by an eviction mid-run — launch it again (at-least-once).
    for (const executionId of Object.keys(state.pendingTriggers)) {
      this.#launchExecution(executionId);
    }
    // A wake that finds schedules due while the fold has not advanced since
    // the previous wake is making no progress (wedged ingest, poison batch):
    // back off toward the heartbeat instead of re-arming at the minimum delay
    // forever. Any checkpoint movement resets the backoff. The cursor is read
    // AFTER the appends, exactly where the old instance read sat.
    const { offset: checkpointOffset } = await this.deps.reads.snapshot();
    const barren = due.length > 0 && this.#lastWakeCheckpointOffset === checkpointOffset;
    this.#lastWakeCheckpointOffset = checkpointOffset;
    if (barren) {
      this.#consecutiveBarrenWakes += 1;
      await this.deps.repointAlarm(barrenWakeAtMs(now, this.#consecutiveBarrenWakes));
    } else {
      this.#consecutiveBarrenWakes = 0;
      await this.deps.repointAlarm(nextWakeAtMs(state, now));
    }
    return { requested: due.length };
  }

  /** Build a validated `schedule-set` append input (the DO appends it). */
  buildScheduleSetEvent(payload: ScheduleSetPayload) {
    return this.contract.buildEvent({
      type: "events.iterate.com/scheduler/schedule-set",
      payload,
    });
  }

  /** Build a validated `schedule-cancelled` append input. */
  buildScheduleCancelledEvent(key: string) {
    return this.contract.buildEvent({
      type: "events.iterate.com/scheduler/schedule-cancelled",
      payload: { key },
    });
  }

  /**
   * Build a manual "run now" `trigger-requested` for an existing key.
   * Deliberately not idempotency-keyed: every manual trigger is a new Trigger.
   * Note the reduce consequence: a manual trigger advances a recurring
   * Schedule's clock and consumes a one-shot.
   */
  async buildManualTriggerEvent(key: string) {
    const { state } = await this.deps.reads.snapshot();
    assertSchedulerCreated(state);
    const entry = state.schedules[key];
    if (entry === undefined) throw new Error(`no schedule under key "${key}"`);
    const nowIso = new Date(this.deps.now()).toISOString();
    const executionId = crypto.randomUUID();
    const event = this.contract.buildEvent({
      type: "events.iterate.com/scheduler/trigger-requested",
      payload: {
        executionId,
        key,
        requestedAt: nowIso,
        runCount: entry.runCount + 1,
        scheduledFor: nowIso,
      },
    });
    return { event, executionId };
  }

  /** One key's Schedule as the public view shape, or undefined. */
  async getScheduleView(key: string): Promise<ScheduleView | undefined> {
    const { state } = await this.deps.reads.snapshot();
    assertSchedulerCreated(state);
    return scheduleViewFromState(state, key);
  }

  /** Every Schedule, sorted by key — the UI list is exactly this. One
   * snapshot read serves the whole list, so it is internally consistent. */
  async listScheduleViews(): Promise<ScheduleView[]> {
    const { state } = await this.deps.reads.snapshot();
    assertSchedulerCreated(state);
    return Object.keys(state.schedules)
      .sort()
      .map((key) => scheduleViewFromState(state, key)!);
  }

  async assertCreated(): Promise<void> {
    const { state } = await this.deps.reads.snapshot();
    assertSchedulerCreated(state);
  }

  #launchExecution(executionId: string, barrierOffset = 0): void {
    if (this.#inflightExecutions.has(executionId)) return;
    this.#inflightExecutions.add(executionId);
    this.runInBackground(async () => {
      try {
        await this.#execute(executionId, barrierOffset);
      } finally {
        this.#inflightExecutions.delete(executionId);
      }
    });
  }

  async #execute(executionId: string, barrierOffset: number): Promise<void> {
    // Read-your-writes barrier: launched from inside a frame, this runs
    // concurrently with the commit that makes the trigger visible in the
    // committed fold. Sweep-launched executions pass 0 and short-circuit.
    // Both the barrier and every fold read below are RUNNER-backed
    // (deps.reads): instance reads never advance under runner drive.
    await this.deps.reads.waitUntilEvent({ offset: barrierOffset, timeoutMs: 30_000 });
    const { state } = await this.deps.reads.snapshot();
    const pending = state.pendingTriggers[executionId];
    if (pending === undefined) return; // already completed (e.g. by a raced sweep)
    const completionIdempotencyKey = this.idempotencyKey(`trigger-completed:${executionId}`);
    // A checkpoint-loss replay redelivers historical requests whose completions
    // sit in LATER catch-up pages — still pending as far as the fold knows.
    // The stream itself always has the truth: one indexed read prevents
    // re-running history.
    const alreadyCompleted = await this.stream.getEvent({
      idempotencyKey: completionIdempotencyKey,
    });
    if (alreadyCompleted !== undefined) return;

    // Latest-code-wins: resolve the Action NOW — a fresh committed-fold read,
    // not the request-time fold and not the pre-barrier read above.
    const { state: freshState } = await this.deps.reads.snapshot();
    const entry = freshState.schedules[pending.key];
    let outcome: {
      definedAtOffset?: number;
      error?: string;
      outcome: "succeeded" | "failed" | "skipped";
      result?: unknown;
    };
    if (entry === undefined) {
      outcome = { outcome: "skipped" };
    } else {
      try {
        const result = await tracing.enterSpan("scheduler action invocation", async (span) => {
          span.setAttribute("iterate.scheduler.execution_id", executionId);
          try {
            const result = await this.deps.dynamicWorkers.invokeCapability({
              args: [
                {
                  key: pending.key,
                  ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
                  path: entry.path,
                  recurrence: entry.recurrence,
                  setAt: entry.setAt,
                },
                {
                  executionId,
                  requestedAt: pending.requestedAt,
                  runCount: pending.runCount,
                  scheduledFor: pending.scheduledFor,
                },
              ],
              path: ["run"],
              ref: scheduleActionWorkerRef(entry.action.script),
              traceRole: "scheduler_action",
            });
            span.setAttribute("iterate.scheduler.action_outcome", "succeeded");
            return result;
          } catch (error) {
            span.setAttribute("iterate.scheduler.action_outcome", "failed");
            throw error;
          }
        });
        outcome = {
          definedAtOffset: entry.definedAtOffset,
          outcome: "succeeded",
          ...(result === undefined ? {} : { result: json(result) }),
        };
      } catch (error) {
        outcome = {
          definedAtOffset: entry.definedAtOffset,
          error: error instanceof Error ? error.message : String(error),
          outcome: "failed",
        };
      }
    }
    // The completion append sits OUTSIDE the try: an append failure is a
    // transport problem, not a script outcome — let it propagate so the
    // trigger stays pending and the next wake's sweep retries, instead of
    // durably recording a succeeded script as failed.
    await this.append({
      type: "events.iterate.com/scheduler/trigger-completed",
      idempotencyKey: completionIdempotencyKey,
      payload: { ...outcome, executionId, key: pending.key },
    });
  }
}

function assertSchedulerCreated(state: SchedulerProcessorState): void {
  if (state.birthCertificate === null) {
    throw new Error("scheduler has not been created");
  }
}

/** One key's Schedule from an explicit fold as the public view shape, or
 * undefined — pure so both view methods serve one consistent snapshot. */
function scheduleViewFromState(
  state: SchedulerProcessorState,
  key: string,
): ScheduleView | undefined {
  const entry = state.schedules[key];
  if (entry === undefined) return undefined;
  return {
    action: entry.action,
    definedAtOffset: entry.definedAtOffset,
    key,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    nextTriggerAt:
      entry.nextTriggerAt === null ? null : new Date(entry.nextTriggerAt).toISOString(),
    recurrence: entry.recurrence,
    runCount: entry.runCount,
    setAt: entry.setAt,
  };
}

/**
 * Same stateless inline-worker shape as capability-host script execution
 * (`bundle: false` = the loader-ready fast path), with the scheduler's
 * three-argument call convention: `fn(itx, schedule, trigger)`.
 */
function scheduleActionWorkerRef(script: string): StatelessDynamicWorkerRef {
  const source = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    const fn = ${script};
    export class ScheduleActionEntrypoint extends WorkerEntrypoint {
      async run(schedule, trigger) {
        const itx = await this.env.ITX.get();
        return await fn(itx, schedule, trigger);
      }
    }
  `;
  return {
    entrypoint: "ScheduleActionEntrypoint",
    path: "/",
    source: {
      files: { files: { "main.js": source }, type: "inline" },
      options: { bundle: false, entryPoint: "main.js" },
    },
    type: "stateless",
  };
}

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
