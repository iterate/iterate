import { DurableObject, tracing } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import type { ScheduleView } from "./types.ts";
import { SchedulerProcessor } from "./scheduler-processor-implementation.ts";
import {
  SchedulerProcessorContract,
  type ScheduleSetPayload,
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
 * alarm, the processor host, and the injected runtime dependencies; all
 * scheduling logic lives in the (hostless-testable) processor.
 *
 * `alarm()` is the only wake source the scheduler needs while hibernated:
 * catch up (pull — push delivery may be stale or wedged), request Triggers for
 * everything due, then catch up again so the requested events ingest and their
 * executions launch before the DO goes back to sleep. The processor re-arms
 * the alarm at the end of every batch and every triggerDue, capped by its
 * heartbeat, so a scheduler holding any state is never alarm-less; an emptied
 * scheduler deletes its alarm and sleeps for good until the next set.
 *
 * The command methods (set/cancel/trigger/list) are the itx write path: they
 * append, pull the event through ingestion, and only then return — so a
 * successful set is read-your-writes visible AND provably alarm-armed.
 */
export class SchedulerDurableObject extends DurableObject<Env> {
  readonly #name = parseSchedulerDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  readonly #schedulerProcessor = this.#processorHost.add(
    (deps) =>
      new SchedulerProcessor({
        ...deps,
        // Schedule Actions run with project-root itx authority: the scheduler
        // is a project-global service, so its scripts see the same surface an
        // agent's project-root capability chain does.
        dynamicWorkers: new DynamicWorkerRunner({
          exports: this.ctx.exports,
          projectId: this.#name.projectId,
          scopePath: "/",
          waitUntil: (promise) => this.ctx.waitUntil(promise),
        }),
        now: () => Date.now(),
        // The DO alarm is SHARED with the processor host's keepalive, so the
        // scheduler states its desire through a named slice and the host arms
        // the earliest across all of them. Early fires (the keepalive's) run
        // alarm() below, which is idempotent and re-arms this slice.
        readAlarm: async () => this.#processorHost.getAlarmSlice("scheduler"),
        repointAlarm: (atMs) => this.#processorHost.setAlarmSlice("scheduler", atMs),
      }),
  );

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // The shared alarm may be firing for the keepalive's slice, the
    // scheduler's, or both — run both handlers; each is idempotent and
    // re-derives its own next fire time.
    await this.#processorHost.handleAlarm(alarmInfo);
    await tracing.enterSpan("alarm scheduler trigger due", async (span) => {
      span.setAttribute("iterate.alarm.kind", "scheduler_trigger_due");
      span.setAttribute("iterate.project.id", this.#name.projectId);
      span.setAttribute("iterate.stream.path", this.#name.path.slice(0, 256));
      if (alarmInfo !== undefined) {
        span.setAttribute("iterate.alarm.is_retry", alarmInfo.isRetry);
        span.setAttribute("iterate.alarm.retry_count", alarmInfo.retryCount);
      }
      try {
        await this.#processorHost.catchUp(PROCESSOR_SLUG);
        const { requested } = await this.#schedulerProcessor.triggerDue();
        span.setAttribute("iterate.scheduler.requested", requested);
        await this.#processorHost.catchUp(PROCESSOR_SLUG);
      } catch (error) {
        // Cloudflare retries a throwing alarm handler only a bounded number of
        // times; a prolonged Stream DO outage must not end with due schedules
        // and no armed alarm. Arm a coarse fallback — AWAITED, so the alarm is
        // durably armed before the rethrow surrenders to the platform's bounded
        // retry/observability.
        await this.#processorHost.setAlarmSlice("scheduler", Date.now() + 60_000);
        throw error;
      }
    });
  }

  async setSchedule(input: ScheduleSetPayload): Promise<ScheduleView> {
    // Fail loudly at set time; raw appends bypass this and park via the reducer.
    assertValidRecurrence(input.recurrence);
    const [event] = await this.#stream.append(
      this.#schedulerProcessor.buildScheduleSetEvent(input),
    );
    await this.#ingestThrough(event!.offset);
    const view = this.#schedulerProcessor.getScheduleView(input.key);
    if (view === undefined) throw new Error(`schedule "${input.key}" not visible after set`);
    return view;
  }

  async cancelSchedule(key: string): Promise<void> {
    const [event] = await this.#stream.append(
      this.#schedulerProcessor.buildScheduleCancelledEvent(key),
    );
    await this.#ingestThrough(event!.offset);
  }

  /** Manual "run now" for an existing key; the Trigger executes like any other. */
  async triggerSchedule(key: string): Promise<{ executionId: string }> {
    await this.#processorHost.catchUp(PROCESSOR_SLUG);
    const { event, executionId } = this.#schedulerProcessor.buildManualTriggerEvent(key);
    const [committed] = await this.#stream.append(event);
    await this.#ingestThrough(committed!.offset);
    return { executionId };
  }

  async listSchedules(): Promise<ScheduleView[]> {
    await this.#processorHost.catchUp(PROCESSOR_SLUG);
    return this.#schedulerProcessor.listScheduleViews();
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#schedulerProcessor);
  }

  // catchUp swallows failures by design (it serves stale state to reads), so
  // the write path adds a hard wait: the command only returns once the fold
  // provably includes the event it just appended.
  async #ingestThrough(offset: number): Promise<void> {
    await this.#processorHost.catchUp(PROCESSOR_SLUG);
    await this.#schedulerProcessor.waitUntilEvent({ offset, timeoutMs: INGEST_WAIT_TIMEOUT_MS });
  }
}
