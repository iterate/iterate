import { DurableObject } from "cloudflare:workers";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type {
  ProcessorSnapshot,
  StreamProcessorWakeRequest,
  StreamProcessorWakeResponse,
} from "iterate/processors";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { sameScheduleDefinition, type ScheduleView } from "./types.ts";
import { SchedulerProcessor } from "./scheduler-processor-implementation.ts";
import {
  parseScheduleSetPayload,
  SchedulerProcessorContract,
  type ScheduleSetPayload,
  type SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";
import { assertValidRecurrence } from "./recurrence.ts";
import { parseSchedulerDurableObjectName } from "./utils.ts";

const PROCESSOR_SLUG = SchedulerProcessorContract.slug;
// Read-your-writes bound for the command surface; catchUp normally satisfies
// the wait immediately, so this only fires when ingestion is genuinely broken.
const INGEST_WAIT_TIMEOUT_MS = 15_000;

/**
 * One Scheduler: the Durable Object hosting the scheduler processor for one
 * `/scheduler/**` stream. The DO owns exactly three things — the platform
 * alarm, the processor registry, and the injected runtime dependencies; all
 * scheduling logic lives in the (runner-testable) processor.
 *
 * `alarm()` is the only wake source the scheduler needs while hibernated:
 * catch up (pull — push delivery may be stale or wedged), request Triggers for
 * everything due, then catch up again so the requested events ingest and their
 * executions launch before the DO goes back to sleep. The processor re-arms
 * the alarm at the head of every delivery and every triggerDue, capped by its
 * heartbeat, so a scheduler holding any state is never alarm-less; an emptied
 * scheduler deletes its alarm and sleeps for good until the next set.
 *
 * The domain alarm IS the scheduler's recovery: every fire re-derives the due
 * set (and the orphaned-execution sweep) from the reduced state, so the
 * processor is registered WITHOUT keepalive recovery — there is no revival
 * fact to consume; a lost incarnation's in-flight executions are re-launched
 * by the next wake.
 *
 * The command methods (set/cancel/trigger/list) are the itx write path: they
 * append, pull the event through ingestion, and only then return — so a
 * successful set is read-your-writes visible AND provably alarm-armed.
 */
export class SchedulerDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = parseSchedulerDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  // The DO constructs the processor — no host-injected readState/writeState;
  // the runner owns durable progress. NO keepalive recovery on purpose: the
  // scheduler's DOMAIN alarm is its recovery. While anything is pending the
  // reduced state keeps `nextWakeAtMs` non-null (heartbeat-capped), the
  // at-head repoint is awaited before the frame commits, and every fire's
  // triggerDue re-derives the due set AND re-launches orphaned pending
  // executions from that state — so `runInBackground` executions lost to an
  // eviction are recovered without a `stream/processor-revived` fact (see the
  // registry module doc's recovery rule).
  readonly #schedulerProcessor = this.#registry.register(
    new SchedulerProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      // Schedule Actions run with project-root itx authority: the scheduler
      // is a project-global service, so its scripts see the same surface an
      // agent's project-root capability chain does.
      dynamicWorkers: new DynamicWorkerRunner({
        streamContext: { kind: "scope", scopePath: this.#name.path },
        exports: this.ctx.exports,
        projectId: this.#name.projectId,
        scopePath: "/",
      }),
      now: () => Date.now(),
      // Keep the incarnation alive while an execution attempt runs (the old
      // host's keepAliveWhile lane, minus its revival alarm — see above).
      keepAliveWhile: (work) => this.ctx.waitUntil(work()),
      // The DO alarm is SHARED with the runners' keepalives, so the scheduler
      // states its desire through a named slice and the registry arms the
      // earliest across all of them. Early fires (another slice's) run
      // alarm() below, which is idempotent and re-arms this slice.
      readAlarm: async () => this.#registry.getAlarmSlice("scheduler"),
      repointAlarm: (atMs) => this.#registry.setAlarmSlice("scheduler", atMs),
      // Runner-backed committed-state reads (triggerDue, executions, views): lazy
      // closures because #reads is built from the registered processor below.
      // The explicit return annotations break the field-initializer inference
      // cycle (these closures read #reads, which is built from this field).
      reads: {
        snapshot: (): Promise<ProcessorSnapshot<SchedulerProcessorState>> => this.#reads.snapshot(),
        waitUntilEvent: (input: { offset: number; timeoutMs?: number }): Promise<void> =>
          this.#reads.waitUntilEvent(input),
      },
    }),
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (snapshots, the processor facade, the command
  // surface's read-your-writes wait) goes through the runner's progress.
  readonly #reads = this.#registry.reads(this.#schedulerProcessor);
  #writeChain: Promise<unknown> = Promise.resolve();

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // The shared alarm may be firing for a keepalive slice, the scheduler's,
    // or both — run both handlers; each is idempotent and re-derives its own
    // next fire time (the registry services every runner, then the scheduler
    // re-derives its due set from the reduced state and re-arms its slice).
    await this.#registry.handleAlarm(alarmInfo);
    try {
      await this.#registry.catchUp(PROCESSOR_SLUG);
      await this.#schedulerProcessor.triggerDue();
      await this.#registry.catchUp(PROCESSOR_SLUG);
    } catch (error) {
      // Cloudflare retries a throwing alarm handler only a bounded number of
      // times; a prolonged Stream DO outage must not end with due schedules
      // and no armed alarm. Arm a coarse fallback — AWAITED, so the alarm is
      // durably armed before the rethrow surrenders to the platform's bounded
      // retry/observability.
      await this.#registry.setAlarmSlice("scheduler", Date.now() + 60_000);
      throw error;
    }
  }

  setSchedule(input: ScheduleSetPayload): Promise<ScheduleView> {
    return this.#serializeWrite(async () => {
      await this.#registry.catchUp(PROCESSOR_SLUG);
      await this.#schedulerProcessor.assertCreated();
      // Fail loudly at set time; raw appends bypass this and park via reduce.
      const definition = parseScheduleSetPayload(input);
      assertValidRecurrence(definition.recurrence);
      const current = await this.#schedulerProcessor.getScheduleView(definition.key);
      if (current !== undefined && sameScheduleDefinition(current, definition)) return current;
      return await this.#commitSchedule(definition);
    });
  }

  async #commitSchedule(input: ScheduleSetPayload): Promise<ScheduleView> {
    const [event] = await this.#stream.append(
      SchedulerProcessorContract.buildEvent({
        type: "events.iterate.com/scheduler/schedule-set",
        payload: input,
      }),
    );
    await this.#waitUntilProcessed(event!.offset);
    const view = await this.#schedulerProcessor.getScheduleView(input.key);
    if (view === undefined) throw new Error(`schedule "${input.key}" not visible after set`);
    return view;
  }

  cancelSchedule(key: string): Promise<void> {
    return this.#serializeWrite(async () => {
      await this.#registry.catchUp(PROCESSOR_SLUG);
      await this.#schedulerProcessor.assertCreated();
      const [event] = await this.#stream.append(
        SchedulerProcessorContract.buildEvent({
          type: "events.iterate.com/scheduler/schedule-cancelled",
          payload: { key },
        }),
      );
      await this.#waitUntilProcessed(event!.offset);
    });
  }

  /** Manual "run now" for an existing key; the Trigger executes like any other. */
  triggerSchedule(key: string): Promise<{ executionId: string }> {
    return this.#serializeWrite(async () => {
      await this.#registry.catchUp(PROCESSOR_SLUG);
      await this.#schedulerProcessor.assertCreated();
      const { event, executionId } = await this.#schedulerProcessor.buildManualTriggerEvent(key);
      const [committed] = await this.#stream.append(event);
      await this.#waitUntilProcessed(committed!.offset);
      return { executionId };
    });
  }

  async listSchedules(): Promise<ScheduleView[]> {
    await this.#registry.catchUp(PROCESSOR_SLUG);
    await this.#schedulerProcessor.assertCreated();
    return await this.#schedulerProcessor.listScheduleViews();
  }

  wakeStreamProcessor(args: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse> {
    return this.#registry.wakeStreamProcessor(args);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#reads), never the processor instance — see the
    // field comment: instance reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(PROCESSOR_SLUG),
    });
  }

  // The offset wait self-pulls and owns the complete read-your-writes
  // timeout. Do not put an unbounded catch-up RPC in front of it.
  async #waitUntilProcessed(offset: number): Promise<void> {
    await this.#reads.waitUntilEvent({ offset, timeoutMs: INGEST_WAIT_TIMEOUT_MS });
  }

  #serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(write, write);
    this.#writeChain = result.catch(() => {});
    return result;
  }
}
