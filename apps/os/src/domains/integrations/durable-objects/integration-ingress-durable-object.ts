// Hosts the "integration-ingress" router processor for ONE integration,
// subscribed to the GLOBAL-namespace capture stream
// `{global}:/integrations/{slug}/webhooks`. One instance per integration per
// deployment. The cross-namespace forward (global → owning project) happens
// here, in the host-supplied dep.

import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
import { ensureStartedOrInitializeFromRuntimeName } from "~/domains/streams/stream-processor-do-helpers.ts";
import {
  integrationAccountStreamPath,
  integrationIngressStreamPath,
} from "~/domains/integrations/integration-events.ts";
import { getIntegrationIngressDurableObjectName } from "~/domains/integrations/integration-naming.ts";
import {
  IntegrationIngressProcessor,
  IntegrationIngressProcessorContract,
} from "~/domains/integrations/stream-processors/integration-ingress/implementation.ts";
import { ensureIntegrationStub } from "~/domains/integrations/durable-objects/integration-durable-object.ts";

export { getIntegrationIngressDurableObjectName };

const IntegrationIngressDurableObjectStructuredName = z.object({
  integration: z.string().trim().min(1),
});
export type IntegrationIngressDurableObjectStructuredName = z.infer<
  typeof IntegrationIngressDurableObjectStructuredName
>;

/** Mint an initialized ingress-router DO stub from a trusted domain file (see lint rule). */
export async function ensureIntegrationIngressStub(integration: string) {
  return await getInitializedDoStub({
    allowCreate: true,
    name: { integration },
    namespace: (env as unknown as IntegrationIngressEnv).INTEGRATION_INGRESS,
  });
}

type IntegrationIngressEnv = {
  DO_CATALOG: D1Database;
  GLOBAL_STREAM_NAMESPACE: string;
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
      forwardToAccount: async ({ account, event, projectId }) => {
        const { integration } = await this.ensureParams();
        const accountStream = await getInitializedStreamStub({
          durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
          namespace: projectId,
          path: integrationAccountStreamPath(integration, account),
        });
        await accountStream.append(event as Parameters<typeof accountStream.append>[0]);
        // Pre-warm the account's integration DO so its subscription handshake
        // races the append instead of queuing behind a cold dial.
        await ensureIntegrationStub({ account, integration, projectId });
      },
    });
  });

  constructor(ctx: DurableObjectState, env: IntegrationIngressEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIngressSubscription(params);
    });
  }

  /** Closure-bridged because the lifecycle mixin's getDurableObjectName is protected. */
  private ensureParams() {
    return ensureStartedOrInitializeFromRuntimeName({
      ensureStarted: () => this.ensureStarted(),
      getDurableObjectName: () => this.getDurableObjectName(),
      initialize: (input) => this.initialize(input),
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureParams();
    return await this.host.requestStreamSubscription(args);
  }

  async ensureReady() {
    const params = await this.ensureParams();
    await this.ensureIngressSubscription(params);
    return await this.router.snapshot();
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
