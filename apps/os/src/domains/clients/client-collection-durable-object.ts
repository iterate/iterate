import { DurableObject } from "cloudflare:workers";
import { LiveStateRpcTarget } from "iterate/sdk/capnweb";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildHostedProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import {
  CLIENT_COLLECTION_CREATED_EVENT_TYPE,
  ClientCollectionProcessorContract,
  type ClientCollectionProcessorState,
} from "./client-collection-processor-contract.ts";
import { ClientCollectionStreamProcessor } from "./client-collection-processor-implementation.ts";

export class ClientCollectionDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
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
    getLiveState: (): ClientCollectionProcessorState => this.#reads.currentState,
  });
  readonly #processor = this.#registry.register(
    new ClientCollectionStreamProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  readonly #reads = this.#registry.reads(this.#processor);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const durableObjectName = DurableObjectNameCodec.stringify(this.#name);
      await this.#stream.append(
        ClientCollectionProcessorContract.buildEvent({
          type: CLIENT_COLLECTION_CREATED_EVENT_TYPE,
          idempotencyKey: `client-collection/created:${durableObjectName}`,
          payload: {},
        }),
        buildHostedProcessorSubscriptionConfiguredEvent({
          durableObjectName,
          idempotencyKey: `stream/subscription-configured:${durableObjectName}#${ClientCollectionProcessorContract.slug}`,
          processor: ["clients", "processor"],
          processorSlug: ClientCollectionProcessorContract.slug,
        }),
      );
    });
  }

  wakeStreamProcessor(args: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse> {
    return this.#registry.wakeStreamProcessor(args);
  }

  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(ClientCollectionProcessorContract.slug),
    });
  }

  get liveState() {
    return new LiveStateRpcTarget(this.#registry);
  }
}
