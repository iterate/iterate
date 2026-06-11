// Hosts the project-side "integration" processor: one instance per
// (project, integration), subscribed to `{projectId}:/integrations/{slug}`.
// The generic sibling of SlackIntegrationDurableObject — provider-specific
// fan-out plugs in through IntegrationProcessorDeps.onIntegrationEvent.

import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { integrationStreamPath } from "~/domains/integrations/integration-events.ts";
import { getIntegrationDurableObjectName } from "~/domains/integrations/integration-naming.ts";
import {
  IntegrationProcessor,
  IntegrationProcessorContract,
} from "~/domains/integrations/stream-processors/integration/implementation.ts";

export { getIntegrationDurableObjectName };

const IntegrationDurableObjectStructuredName = z.object({
  integration: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});
export type IntegrationDurableObjectStructuredName = z.infer<
  typeof IntegrationDurableObjectStructuredName
>;

/** Mint an integration DO stub from a trusted domain file (see lint rule). */
export function getIntegrationStub(input: IntegrationDurableObjectStructuredName) {
  return (env as unknown as IntegrationEnv).INTEGRATION.getByName(
    getIntegrationDurableObjectName(input),
  );
}

type IntegrationEnv = {
  DO_CATALOG: D1Database;
  INTEGRATION: DurableObjectNamespace<IntegrationDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

const IntegrationLifecycleBase = createIterateDurableObjectBase<
  typeof IntegrationDurableObjectStructuredName,
  Pick<IntegrationEnv, "DO_CATALOG">
>({
  className: "IntegrationDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
  },
  nameSchema: IntegrationDurableObjectStructuredName,
});

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class IntegrationDurableObject extends IntegrationLifecycleBase<IntegrationEnv> {
  host = createStreamProcessorHost(this.ctx);
  integration = this.host.add(IntegrationProcessorContract.slug, (deps) => {
    return new IntegrationProcessor({
      ...deps,
      // The fan-out seam stays open in the spike: routed events fold into
      // state and sit on the stream for any subscriber. The Slack thread
      // router becomes an onIntegrationEvent here when slack migrates.
    });
  });

  constructor(ctx: DurableObjectState, env: IntegrationEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIntegrationSubscription(params);
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params);
    return await this.integration.snapshot();
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }

  private async ensureIntegrationSubscription(params: IntegrationDurableObjectStructuredName) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: integrationStreamPath(params.integration),
    });
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `integration-subscription:${params.projectId}:${params.integration}`,
      payload: {
        subscriptionKey: `integration:${params.projectId}:${params.integration}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "INTEGRATION",
          durableObjectName: getIntegrationDurableObjectName(params),
          processorName: IntegrationProcessorContract.slug,
        }),
      },
    });
  }
}
