import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import type { WorkerBuildArtifact } from "./artifact-store.ts";
import {
  WorkerBuildCoordinator,
  type WorkerBuildCoordinatorEvent,
} from "./worker-build-coordinator.ts";
import {
  executeCoordinatedWorkerBuild,
  type WorkerBuildRequest,
} from "./worker-build-capability.ts";

/** One globally addressed coordinator per immutable worker build key. */
export class WorkerBuildCoordinatorDurableObject extends DurableObject<Env> {
  readonly #coordinator = new WorkerBuildCoordinator(
    (request) => executeCoordinatedWorkerBuild(request, this.env),
    { observe: observeCoordinatorEvent },
  );

  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  build(request: WorkerBuildRequest): Promise<WorkerBuildArtifact> {
    if (!/^[a-f0-9]{64}$/.test(request.buildKey)) {
      throw new TypeError("worker build key must be a lowercase SHA-256 digest");
    }
    if (this.ctx.id.name !== request.buildKey) {
      throw new TypeError("worker build request does not match its coordinator identity");
    }

    const operation = this.#coordinator.build(request);
    // The browser may stop waiting at its serve budget, but the immutable
    // artifact remains useful. Anchor the elected operation in the actor; a
    // refresh then joins this flight or reads the KV result it produces. Do
    // not use blockConcurrencyWhile: Cloudflare resets an object when its
    // callback exceeds 30 seconds, while dependency installation may be slow.
    // https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
    this.ctx.waitUntil(
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }
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
