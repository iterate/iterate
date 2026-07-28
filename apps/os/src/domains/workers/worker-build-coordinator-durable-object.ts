import { DurableObject } from "cloudflare:workers";
import {
  workerDeploymentVersionRpcResponse,
  type Env,
  type WorkerDeploymentVersion,
  type WorkerDeploymentVersionFormat,
} from "../../env.ts";
import { type WorkerBuildFailure, type WorkerBuildResult } from "./artifact-store.ts";
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

/** One globally addressed coordinator per immutable worker build key. */
export class WorkerBuildCoordinatorDurableObject extends DurableObject<Env> {
  readonly #coordinator = new WorkerBuildCoordinator(
    async (request) => {
      const result = await executeCoordinatedWorkerBuild(request, this.env);
      if (!result.ok) this.#rememberTerminalFailure(result.failure);
      return result;
    },
    { observe: observeCoordinatorEvent },
  );

  /** Report this incarnation's code version for the deployment rollout gate.
   * No argument preserves the legacy string RPC contract; new callers opt in
   * to ordering metadata so both sides of a rollout remain compatible. */
  deploymentVersion(): string;
  deploymentVersion(format: WorkerDeploymentVersionFormat): WorkerDeploymentVersion;
  deploymentVersion(format?: WorkerDeploymentVersionFormat): WorkerDeploymentVersion | string {
    return format === undefined
      ? workerDeploymentVersionRpcResponse(this.env)
      : workerDeploymentVersionRpcResponse(this.env, format);
  }

  async build(request: WorkerBuildRequest, buildBudgetMs?: number): Promise<WorkerBuildResult> {
    this.#assertRequest(request);
    if (buildBudgetMs !== undefined && (!Number.isFinite(buildBudgetMs) || buildBudgetMs < 0)) {
      throw new TypeError("worker build budget must be a non-negative finite number");
    }
    const terminalFailure = this.#takeTerminalFailure();
    if (terminalFailure !== undefined) return { failure: terminalFailure, ok: false };

    const operation = this.#coordinator.build(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result =
        buildBudgetMs === undefined
          ? await operation
          : await Promise.race([
              operation,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  this.enqueue(request).then(() => reject(workerBuildInProgressError()), reject);
                }, buildBudgetMs);
              }),
            ]);
      // The foreground caller received this exact terminal result, so there is
      // no later caller to inform. Receipts remain only when timeout/alarm
      // ownership outlives the caller that started the operation.
      if (!result.ok) this.ctx.storage.kv.delete(TERMINAL_BUILD_FAILURE_STORAGE_KEY);
      return result;
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
    await this.#coordinator.build(request);
    // A source failure is a modeled terminal result, not an alarm retry. The
    // coordinator execution stored it for a foreground caller, including one
    // in a later actor incarnation. Infrastructure failures still throw above,
    // leaving the queue intact for the platform's native alarm retry.
    this.ctx.storage.kv.delete(QUEUED_BUILD_STORAGE_KEY);
  }

  #rememberTerminalFailure(failure: WorkerBuildFailure): void {
    this.ctx.storage.kv.put(TERMINAL_BUILD_FAILURE_STORAGE_KEY, failure);
  }

  #hasTerminalFailure(): boolean {
    return (
      this.ctx.storage.kv.get<WorkerBuildFailure>(TERMINAL_BUILD_FAILURE_STORAGE_KEY) !== undefined
    );
  }

  #takeTerminalFailure(): WorkerBuildFailure | undefined {
    const failure = this.ctx.storage.kv.get<WorkerBuildFailure>(TERMINAL_BUILD_FAILURE_STORAGE_KEY);
    if (failure !== undefined) this.ctx.storage.kv.delete(TERMINAL_BUILD_FAILURE_STORAGE_KEY);
    return failure;
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
  // Source failure is an expected build result; infrastructure failure is
  // thrown into the operation-wide exception signal. This record is neutral
  // coordination telemetry for both, never a second error counter.
  console.log("dynamic worker build coordinator", {
    event: `worker-build.${event.kind}`,
    ...event,
  });
}
