import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
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
        readAlarm: () => this.ctx.storage.getAlarm(),
        repointAlarm: (atMs) =>
          atMs === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(atMs),
      }),
  );

  async alarm(): Promise<void> {
    try {
      await this.#processorHost.catchUp(PROCESSOR_SLUG);
      await this.#schedulerProcessor.triggerDue();
      await this.#processorHost.catchUp(PROCESSOR_SLUG);
    } catch (error) {
      // Cloudflare retries a throwing alarm handler only a bounded number of
      // times; a prolonged Stream DO outage must not end with due schedules
      // and no armed alarm. Arm a coarse fallback, then rethrow for the
      // platform's own retry/observability.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      throw error;
    }
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

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
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
