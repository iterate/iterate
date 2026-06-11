// Hosts the "integration-ingress" router processor for ONE integration,
// subscribed to the GLOBAL-namespace capture stream
// `{global}:/integrations/{slug}/webhooks`. One instance per integration per
// deployment. The cross-namespace forward (global → owning project) happens
// here, in the host-supplied dep.

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
import {
  integrationIngressStreamPath,
  integrationStreamPath,
} from "~/domains/integrations/integration-events.ts";
import {
  getIntegrationDurableObjectName,
  getIntegrationIngressDurableObjectName,
} from "~/domains/integrations/integration-naming.ts";
import {
  IntegrationIngressProcessor,
  IntegrationIngressProcessorContract,
} from "~/domains/integrations/stream-processors/integration-ingress/implementation.ts";
import type { IntegrationDurableObject } from "~/domains/integrations/durable-objects/integration-durable-object.ts";

export { getIntegrationIngressDurableObjectName };

const IntegrationIngressDurableObjectStructuredName = z.object({
  integration: z.string().trim().min(1),
});
export type IntegrationIngressDurableObjectStructuredName = z.infer<
  typeof IntegrationIngressDurableObjectStructuredName
>;

/** Mint an ingress-router DO stub from a trusted domain file (see lint rule). */
export function getIntegrationIngressStub(integration: string) {
  return (env as unknown as IntegrationIngressEnv).INTEGRATION_INGRESS.getByName(
    getIntegrationIngressDurableObjectName({ integration }),
  );
}

type IntegrationIngressEnv = {
  DO_CATALOG: D1Database;
  GLOBAL_STREAM_NAMESPACE: string;
  INTEGRATION: DurableObjectNamespace<IntegrationDurableObject>;
  INTEGRATION_INGRESS: DurableObjectNamespace<IntegrationIngressDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

const IntegrationIngressLifecycleBase = createIterateDurableObjectBase<
  typeof IntegrationIngressDurableObjectStructuredName,
  Pick<IntegrationIngressEnv, "DO_CATALOG">
>({
  className: "IntegrationIngressDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    integration: (params) => params.integration,
  },
  nameSchema: IntegrationIngressDurableObjectStructuredName,
});

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class IntegrationIngressDurableObject extends IntegrationIngressLifecycleBase<IntegrationIngressEnv> {
  host = createStreamProcessorHost(this.ctx);
  router = this.host.add(IntegrationIngressProcessorContract.slug, (deps) => {
    return new IntegrationIngressProcessor({
      ...deps,
      forwardToProject: async ({ projectId, event }) => {
        const { integration } = await this.ensureStartedOrInitializeFromRuntimeName();
        const projectStream = await getInitializedStreamStub({
          durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
          namespace: projectId,
          path: integrationStreamPath(integration),
        });
        await projectStream.append(event as Parameters<typeof projectStream.append>[0]);
        // Pre-warm the project's integration DO so its subscription handshake
        // races the append instead of queuing behind a cold dial.
        const integrationDoName = getIntegrationDurableObjectName({ integration, projectId });
        await this.env.INTEGRATION.getByName(integrationDoName).initialize({
          name: integrationDoName,
        });
      },
    });
  });

  constructor(ctx: DurableObjectState, env: IntegrationIngressEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIngressSubscription(params);
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIngressSubscription(params);
    return await this.router.snapshot();
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

  private async ensureIngressSubscription(params: IntegrationIngressDurableObjectStructuredName) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.env.GLOBAL_STREAM_NAMESPACE,
      path: integrationIngressStreamPath(params.integration),
    });
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `integration-ingress-subscription:${params.integration}`,
      payload: {
        subscriptionKey: `integration-ingress:${params.integration}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "INTEGRATION_INGRESS",
          durableObjectName: getIntegrationIngressDurableObjectName(params),
          processorName: IntegrationIngressProcessorContract.slug,
        }),
      },
    });
  }
}
