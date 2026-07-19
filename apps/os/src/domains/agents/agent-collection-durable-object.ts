import { DurableObject } from "cloudflare:workers";
import { LiveStateRpcTarget } from "iterate/live-state";
import type {
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { waitUntilAgentCreatedInCollection } from "./agent-collection-created-barrier.ts";
import {
  AGENT_COLLECTION_CREATED_EVENT_TYPE,
  AgentCollectionProcessorContract,
  type AgentCollectionProcessorState,
} from "./agent-collection-processor-contract.ts";
import { AgentCollectionStreamProcessor } from "./agent-collection-processor-implementation.ts";
import { AgentPath } from "./agent-presence.ts";

export class AgentCollectionDurableObject extends DurableObject<Env> {
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
    getLiveState: (): AgentCollectionProcessorState => this.#reads.currentState,
  });
  readonly #processor = this.#registry.register(
    new AgentCollectionStreamProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  readonly #reads = this.#registry.reads(this.#processor);

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(AgentCollectionProcessorContract.slug),
    });
  }

  get liveState() {
    return new LiveStateRpcTarget(this.#registry);
  }

  /** Read-after-create barrier for the collection's reduced agent database. */
  async waitUntilAgentCreated(input: { path: string; timeoutMs: number }): Promise<void> {
    const path = AgentPath.parse(input.path);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("waitUntilAgentCreated timeoutMs must be a positive safe integer");
    }
    await waitUntilAgentCreatedInCollection({
      path,
      reads: this.#reads,
      timeoutMs: input.timeoutMs,
      onLifecycleRetry: ({ attempt, error, maxAttempts }) => {
        console.warn("agent collection creation barrier restarting after lifecycle reset", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
          maxAttempts,
          path,
        });
      },
    });
  }

  /** Receive the collection's deliberately narrow agent-stream push lane. */
  async processEvent(batch: StreamPushEventBatch): Promise<void> {
    const durableObjectName = DurableObjectNameCodec.stringify(this.#name);
    await this.#stream.append(
      AgentCollectionProcessorContract.buildEvent({
        type: AGENT_COLLECTION_CREATED_EVENT_TYPE,
        idempotencyKey: `agent-collection/created:${durableObjectName}`,
        payload: {},
      }),
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName,
        idempotencyKey: `stream/subscription-configured:${durableObjectName}#${AgentCollectionProcessorContract.slug}`,
        processor: ["agents", "processor"],
        processorSlug: AgentCollectionProcessorContract.slug,
      }),
    );
    await this.#stream.acceptCrossPost(batch);
  }
}
