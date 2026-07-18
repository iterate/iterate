import { DurableObject } from "cloudflare:workers";
import { WORKER_BUILDER_POOL_SIZE } from "./builder-pool.ts";
import { CloudflareSandboxWorkerBuildBackend } from "./cloudflare-sandbox-build-backend.ts";
import type { WorkerBuilderDurableObject } from "./builder-pool-sandbox.ts";
import type {
  WorkerBuildDeployment,
  WorkerBuildOutcome,
  WorkerBuildRequest,
} from "./worker-build-contract.ts";
import {
  WorkerBuildCoordinator,
  type WorkerBuildCoordinatorEvent,
} from "./worker-build-coordinator.ts";

/** Bindings owned solely by the route-less builder sidecar. */
interface WorkerBuildCoordinatorEnv {
  WORKER_BUILD_DEPLOYMENT_ID: string;
  WORKER_BUILDER_SANDBOX: DurableObjectNamespace<WorkerBuilderDurableObject>;
}

// Four concurrent builds per standard-4 member: one per vCPU. The adapter
// load-balances those slots across the fixed pool. One additional wave may
// queue, but never indefinitely or without an observable rejection.
const MAX_CONCURRENT_BUILDS = WORKER_BUILDER_POOL_SIZE * 4;
const MAX_QUEUED_BUILDS = MAX_CONCURRENT_BUILDS;
const QUEUE_TIMEOUT_MS = 120_000;

/**
 * The deployment-global dynamic-worker build capability. It owns no durable
 * state: content-addressed artifacts live in the main worker's KV, while this
 * object only coordinates the work currently executing in its incarnation.
 */
export class WorkerBuildCoordinatorDurableObject extends DurableObject<WorkerBuildCoordinatorEnv> {
  readonly #coordinator: WorkerBuildCoordinator;

  constructor(ctx: DurableObjectState, env: WorkerBuildCoordinatorEnv) {
    super(ctx, env);
    this.#coordinator = new WorkerBuildCoordinator(
      new CloudflareSandboxWorkerBuildBackend(env.WORKER_BUILDER_SANDBOX),
      {
        maxConcurrent: MAX_CONCURRENT_BUILDS,
        maxQueued: MAX_QUEUED_BUILDS,
        queueTimeoutMs: QUEUE_TIMEOUT_MS,
        observe: logCoordinatorEvent,
      },
    );
  }

  async build(request: WorkerBuildRequest): Promise<WorkerBuildOutcome> {
    const operation = this.#coordinator.build(request);
    // An RPC caller can disappear (request deadline, deploy, disconnected
    // stream) while the immutable build is still useful. Anchor the one
    // coalesced operation here so a retry joins it instead of starting an
    // abandoned duplicate in another container.
    this.ctx.waitUntil(
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await operation;
  }

  /** Lightweight readiness identity; does not start or inspect a container. */
  async deployment(): Promise<WorkerBuildDeployment> {
    return { deploymentId: this.env.WORKER_BUILD_DEPLOYMENT_ID };
  }
}

function logCoordinatorEvent(event: WorkerBuildCoordinatorEvent): void {
  const record = { event: `worker-build.${event.kind}`, ...event };
  if (event.kind === "errored" || event.kind === "rejected") {
    console.error("worker build coordinator", record);
  } else {
    console.log("worker build coordinator", record);
  }
}
