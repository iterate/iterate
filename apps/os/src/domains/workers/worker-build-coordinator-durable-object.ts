import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import {
  buildFailureMessageFromError,
  isWorkerBuildFailedError,
  WorkerBuildFailedError,
  type WorkerBuildArtifact,
} from "./artifact-store.ts";
import {
  WorkerBuildCoordinator,
  type WorkerBuildCoordinatorEvent,
} from "./worker-build-coordinator.ts";
import {
  executeCoordinatedWorkerBuild,
  type WorkerBuildRequest,
} from "./worker-build-capability.ts";

const QUEUED_BUILD_STORAGE_KEY = "worker-build:queued-request";
const TERMINAL_BUILD_FAILURE_STORAGE_KEY = "worker-build:terminal-failure";

type StoredTerminalBuildFailure = {
  message: string;
  name: "WorkerBuildFailedError";
};

/** One globally addressed coordinator per immutable worker build key. */
export class WorkerBuildCoordinatorDurableObject extends DurableObject<Env> {
  readonly #coordinator = new WorkerBuildCoordinator(
    async (request) => {
      try {
        return await executeCoordinatedWorkerBuild(request, this.env);
      } catch (error) {
        if (isWorkerBuildFailedError(error)) this.#rememberTerminalFailure(error);
        throw error;
      }
    },
    { observe: observeCoordinatorEvent },
  );

  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  async build(request: WorkerBuildRequest, buildBudgetMs?: number): Promise<WorkerBuildArtifact> {
    this.#assertRequest(request);
    if (buildBudgetMs !== undefined && (!Number.isFinite(buildBudgetMs) || buildBudgetMs < 0)) {
      throw new TypeError("worker build budget must be a non-negative finite number");
    }
    const terminalFailure = this.#takeTerminalFailure();
    if (terminalFailure !== undefined) throw terminalFailure;

    const operation = this.#coordinator.build(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (buildBudgetMs === undefined) return await operation;
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.enqueue(request).then(() => reject(workerBuildInProgressError()), reject);
          }, buildBudgetMs);
        }),
      ]);
    } catch (error) {
      // The foreground caller received this exact terminal result, so there is
      // no later caller to inform. Receipts remain only when timeout/alarm
      // ownership outlives the caller that started the operation.
      if (isWorkerBuildFailedError(error)) {
        this.ctx.storage.kv.delete(TERMINAL_BUILD_FAILURE_STORAGE_KEY);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Durably hand a cache-missed build to this key's alarm and return. */
  async enqueue(request: WorkerBuildRequest): Promise<void> {
    this.#assertRequest(request);
    this.ctx.storage.kv.put(QUEUED_BUILD_STORAGE_KEY, request);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Alarm ownership survives the caller, actor eviction, and transient build failure. */
  async alarm(): Promise<void> {
    const request = this.ctx.storage.kv.get<WorkerBuildRequest>(QUEUED_BUILD_STORAGE_KEY);
    if (request === undefined) return;
    this.#assertRequest(request);
    if (this.#hasTerminalFailure()) {
      this.ctx.storage.kv.delete(QUEUED_BUILD_STORAGE_KEY);
      return;
    }
    try {
      await this.#coordinator.build(request);
      this.ctx.storage.kv.delete(QUEUED_BUILD_STORAGE_KEY);
    } catch (error) {
      if (!isWorkerBuildFailedError(error)) throw error;
      // Immutable source failure is a modeled terminal result, not an alarm
      // retry. The coordinator execution stored the exact bounded error for
      // foreground callers, including callers in a later actor incarnation.
      this.ctx.storage.kv.delete(QUEUED_BUILD_STORAGE_KEY);
    }
  }

  #rememberTerminalFailure(error: unknown): void {
    this.ctx.storage.kv.put(TERMINAL_BUILD_FAILURE_STORAGE_KEY, {
      message: buildFailureMessageFromError(error),
      name: "WorkerBuildFailedError",
    } satisfies StoredTerminalBuildFailure);
  }

  #hasTerminalFailure(): boolean {
    return (
      this.ctx.storage.kv.get<StoredTerminalBuildFailure>(TERMINAL_BUILD_FAILURE_STORAGE_KEY) !==
      undefined
    );
  }

  #takeTerminalFailure(): WorkerBuildFailedError | undefined {
    const failure = this.ctx.storage.kv.get<StoredTerminalBuildFailure>(
      TERMINAL_BUILD_FAILURE_STORAGE_KEY,
    );
    if (failure !== undefined) this.ctx.storage.kv.delete(TERMINAL_BUILD_FAILURE_STORAGE_KEY);
    return failure === undefined ? undefined : new WorkerBuildFailedError(failure.message);
  }

  #assertRequest(request: WorkerBuildRequest): void {
    if (!/^[a-f0-9]{64}$/.test(request.buildKey)) {
      throw new TypeError("worker build key must be a lowercase SHA-256 digest");
    }
    if (this.ctx.id.name !== request.buildKey) {
      throw new TypeError("worker build request does not match its coordinator identity");
    }
  }
}

function workerBuildInProgressError(): Error {
  const error = new Error("This worker is still building.");
  error.name = "WorkerBuildInProgressError";
  return error;
}

function observeCoordinatorEvent(event: WorkerBuildCoordinatorEvent) {
  // Source rejection is an expected build outcome; infrastructure failure is
  // rethrown into the operation-wide exception signal. This record is neutral
  // coordination telemetry for both, never a second error counter.
  console.log("dynamic worker build coordinator", {
    event: `worker-build.${event.kind}`,
    ...event,
  });
}
