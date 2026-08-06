import { isStreamIdMismatchError } from "iterate/processors";
import { z } from "zod";
import { isRepoNotSeededError } from "../repos/utils.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { isWorkerBuildFailedError } from "../workers/artifact-store.ts";
import { isWorkerBuildInProgressError } from "../workers/worker-loader.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

const HANDOFF_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 10_000;
const MAX_PROBE_ATTEMPTS = 5;

const WorkerUpdateOutcome = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("events.iterate.com/project/worker-updated"),
    idempotencyKey: z.string().min(1),
    payload: z.strictObject({ commitOid: z.string().trim().min(1) }),
  }),
  z.strictObject({
    type: z.literal("events.iterate.com/project/worker-update-failed"),
    idempotencyKey: z.string().min(1),
    payload: z.strictObject({
      commitOid: z.string().trim().min(1),
      error: z.string().trim().min(1),
    }),
  }),
]);
const ProjectWorkerUpdateHandoff = z.strictObject({
  commitOid: z.string().trim().min(1),
  streamId: z.string().trim().min(1),
});
const QueuedWorkerUpdate = ProjectWorkerUpdateHandoff.extend({
  failedAttempts: z.number().int().nonnegative(),
  outcome: WorkerUpdateOutcome.optional(),
});
const WorkerUpdateQueue = z.array(QueuedWorkerUpdate);

export type ProjectWorkerUpdateHandoff = z.infer<typeof ProjectWorkerUpdateHandoff>;
type WorkerUpdateOutcome = z.infer<typeof WorkerUpdateOutcome>;
type QueuedWorkerUpdate = z.infer<typeof QueuedWorkerUpdate>;

type ProjectWorkerUpdateCoordinatorDeps = {
  append(streamId: string, outcome: WorkerUpdateOutcome): Promise<void>;
  clearAlarm(): Promise<void>;
  deleteQueue(): void;
  getAlarm(): number | null;
  getQueue(): unknown;
  isRetryableError(error: unknown): boolean;
  now(): number;
  probe(): Promise<string>;
  putQueue(queue: QueuedWorkerUpdate[]): void;
  setAlarm(atMs: number): Promise<void>;
};

export function isRetryableProjectWorkerUpdateError(error: unknown): boolean {
  return (
    isRepoNotSeededError(error) ||
    isWorkerBuildInProgressError(error) ||
    isRetryableDurableObjectAvailabilityError(error)
  );
}

/**
 * Durable post-creation worker-update state machine. The Project processor
 * only enqueues; this coordinator is driven by the Project DO's independent
 * alarm so its dynamic-worker probe cannot overlap the root Stream alarm's
 * userspace worker feed in one invocation tree.
 */
export class ProjectWorkerUpdateCoordinator {
  #operationChain: Promise<void> = Promise.resolve();

  constructor(readonly deps: ProjectWorkerUpdateCoordinatorDeps) {}

  enqueue(input: ProjectWorkerUpdateHandoff): Promise<void> {
    return this.#serialize(async () => {
      const handoff = ProjectWorkerUpdateHandoff.parse(input);
      const stored = this.#queue();
      const queue = stored.some((item) => item.streamId !== handoff.streamId) ? [] : stored;
      if (!queue.some((item) => item.commitOid === handoff.commitOid)) {
        queue.push({ ...handoff, failedAttempts: 0 });
        this.deps.putQueue(queue);
      }
      const handoffAt = this.deps.now() + HANDOFF_DELAY_MS;
      const alarmAt = this.deps.getAlarm();
      if (alarmAt === null || alarmAt > handoffAt) await this.deps.setAlarm(handoffAt);
    });
  }

  alarm(): Promise<void> {
    return this.#serialize(async () => {
      const queue = this.#queue();
      const current = queue[0];
      if (current === undefined) {
        this.deps.deleteQueue();
        await this.deps.clearAlarm();
        return;
      }

      let active = current;
      if (active.outcome === undefined) {
        try {
          active = {
            ...active,
            outcome: workerUpdatedOutcome(active.commitOid, await this.deps.probe()),
          };
          this.deps.putQueue([active, ...queue.slice(1)]);
        } catch (error) {
          if (isWorkerBuildFailedError(error)) {
            active = {
              ...active,
              outcome: workerUpdateFailedOutcome(active.commitOid, errorMessage(error)),
            };
            this.deps.putQueue([active, ...queue.slice(1)]);
          } else {
            const failedAttempts = active.failedAttempts + 1;
            if (failedAttempts >= MAX_PROBE_ATTEMPTS) {
              active = {
                ...active,
                failedAttempts,
                outcome: workerUpdateFailedOutcome(
                  active.commitOid,
                  `Default worker readiness failed after ${MAX_PROBE_ATTEMPTS} attempts: ${errorMessage(error)}`,
                ),
              };
              this.deps.putQueue([active, ...queue.slice(1)]);
            } else {
              this.deps.putQueue([{ ...active, failedAttempts }, ...queue.slice(1)]);
              await this.deps.setAlarm(this.deps.now() + RETRY_DELAY_MS);
              if (!this.deps.isRetryableError(error)) throw error;
              console.info("default project worker update will retry after a classified outage", {
                commitOid: active.commitOid,
                failedAttempts,
                maxAttempts: MAX_PROBE_ATTEMPTS,
              });
              return;
            }
          }
        }
      }

      if (active.outcome === undefined) {
        throw new Error("Project worker update reached append without a checkpointed outcome.");
      }
      try {
        await this.deps.append(active.streamId, active.outcome);
      } catch (error) {
        if (isStreamIdMismatchError(error)) {
          this.deps.deleteQueue();
          await this.deps.clearAlarm();
          return;
        }
        await this.deps.setAlarm(this.deps.now() + RETRY_DELAY_MS);
        if (!this.deps.isRetryableError(error)) throw error;
        console.info("default project worker outcome append will retry after a classified outage", {
          commitOid: active.commitOid,
        });
        return;
      }
      await this.#finish(queue);
    });
  }

  #queue(): QueuedWorkerUpdate[] {
    const stored = this.deps.getQueue();
    return stored === undefined ? [] : WorkerUpdateQueue.parse(stored);
  }

  async #finish(queue: QueuedWorkerUpdate[]): Promise<void> {
    const remaining = queue.slice(1);
    if (remaining.length === 0) {
      this.deps.deleteQueue();
      await this.deps.clearAlarm();
      return;
    }
    this.deps.putQueue(remaining);
    await this.deps.setAlarm(this.deps.now());
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationChain.then(operation, operation);
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function workerUpdatedOutcome(triggerCommitOid: string, servedCommitOid: string) {
  return WorkerUpdateOutcome.parse(
    ProjectProcessorContract.parseEventInput({
      type: "events.iterate.com/project/worker-updated",
      // The trigger owns the outcome key even when the readiness probe observes
      // a newer HEAD. Lost acknowledgements therefore find the same result.
      idempotencyKey: internalStreamId("project-worker-update", triggerCommitOid),
      payload: { commitOid: servedCommitOid },
    }),
  );
}

export function workerUpdateFailedOutcome(commitOid: string, error: string) {
  return WorkerUpdateOutcome.parse(
    ProjectProcessorContract.parseEventInput({
      type: "events.iterate.com/project/worker-update-failed",
      idempotencyKey: internalStreamId("project-worker-update", commitOid),
      payload: { commitOid, error },
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
