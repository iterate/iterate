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

    const observationAbort = new AbortController();
    // Register first so an event arriving during catch-up cannot pass between
    // the durable-state check and the future-delivery waiter. Observe rejection
    // immediately: the catch-up may fail or prove the agent is already present,
    // and cancelling the now-unneeded bounded waiter must never reject later as
    // an unhandled promise.
    const delivered = this.#reads.waitUntilEvent({
      predicate: (event) =>
        event.type === "events.iterate.com/agent/created" &&
        event.source?.crossPostedFrom?.at(-1)?.path === path,
      timeoutMs: input.timeoutMs,
      signal: observationAbort.signal,
    });
    const observedDelivery = delivered.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const observedCatchUp = this.#reads.catchUp().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      // A push may reduce the creation while a cold catch-up is still reading
      // older pages, so either successful observation is sufficient. The
      // delivery wait also bounds a stuck catch-up with the caller's deadline.
      const first = await Promise.race([
        observedDelivery.then((observation) => ({ kind: "delivery" as const, observation })),
        observedCatchUp.then((observation) => ({ kind: "catch-up" as const, observation })),
      ]);
      if (first.kind === "delivery") {
        if (first.observation.status === "fulfilled") return;
        throw new Error(`agent collection did not reduce creation of ${path}`, {
          cause: first.observation.error,
        });
      }
      if (first.observation.status === "rejected") {
        throw new Error(`agent collection could not catch up while creating ${path}`, {
          cause: first.observation.error,
        });
      }
      if (this.#reads.currentState.agents[path] !== undefined) return;

      const observation = await observedDelivery;
      if (observation.status === "rejected") {
        throw new Error(`agent collection did not reduce creation of ${path}`, {
          cause: observation.error,
        });
      }
    } finally {
      observationAbort.abort();
      await observedDelivery;
      void observedCatchUp;
    }
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
