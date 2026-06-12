// The integration ACCOUNT, as a domain object: one Durable Object per
// (project, integration, account) — "google" is the type, this DO is "google
// as jonas@nustom.com in this project". It folds
// `{projectId}:/integrations/{slug}/{account}` and implements the itx calling
// convention, so `itx.integrations.{slug}.**` (account "default") and
// `itx.integrations["{slug}:{account}"].**` terminate HERE. The DO is where
// the account's three faces meet:
//
//   - its JOURNAL: connection lifecycle + every routed provider event;
//   - its SDK: built next to the fold (tokens via the Secret DOs' audited
//     trapdoor), gated by the connection state the fold knows;
//   - its FAN-OUT seam: provider-specific reaction to routed events
//     (the Slack thread-router pattern) plugs into the hosted processor.
//
// What deliberately does NOT live here: webhook signature checks (stateless,
// per-request — ingress.ts), the global routing hop (one router DO per
// integration for the whole deployment), and secret material at rest (the
// Secret DOs). One trade-off to know: SDK calls serialize through this DO
// per (project, integration); if an integration runs hot, the SDK surface
// can move back to a stateless loopback that consults this DO's fold.

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
import {
  ensureStartedOrInitializeFromRuntimeName,
  waitForProcessorCatchUp,
} from "~/domains/streams/stream-processor-do-helpers.ts";
import { replayPathCall, type PathCall } from "~/itx/path-proxy.ts";
import { integrationAccountStreamPath } from "~/domains/integrations/integration-events.ts";
import { getIntegrationDurableObjectName } from "~/domains/integrations/integration-naming.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import {
  IntegrationProcessor,
  IntegrationProcessorContract,
} from "~/domains/integrations/stream-processors/integration/implementation.ts";
import { revealJournaledSecretForPlatformUse } from "~/domains/secrets/secret-streams.ts";

export { getIntegrationDurableObjectName };

const IntegrationDurableObjectStructuredName = z.object({
  account: z.string().trim().min(1),
  integration: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});
export type IntegrationDurableObjectStructuredName = z.infer<
  typeof IntegrationDurableObjectStructuredName
>;

/** Mint an initialized integration DO stub from a trusted domain file (see lint rule). */
export async function ensureIntegrationStub(input: IntegrationDurableObjectStructuredName) {
  return await getInitializedDoStub({
    allowCreate: true,
    name: input,
    namespace: (env as unknown as IntegrationEnv).INTEGRATION,
  });
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

  /**
   * The itx surface: itx.integrations.{slug}.<sdk path>(...) terminates here.
   * The SDK is built fresh per call (it's a thin authenticated client), with
   * material dereferenced through the Secret DOs — failures carry the
   * connection state this DO's own fold knows.
   */
  async call(input: PathCall): Promise<unknown> {
    const params = await this.ensureParams();
    const definition = getIntegration(params.integration);
    const secretSpecsByName = Object.fromEntries(
      definition.providedSecrets.map((spec) => [spec.name, spec]),
    );
    const sdk = await definition.createSdk({
      projectId: params.projectId,
      account: params.account,
      getSecretMaterial: async (name) => {
        const spec = secretSpecsByName[name];
        const slug = providedSecretSlug({
          integration: definition.slug,
          account: params.account,
          name,
        });
        try {
          return await revealJournaledSecretForPlatformUse({
            projectId: params.projectId,
            slug,
            usedBy: `integration:${definition.slug}:${params.account}`,
            fallbackEnvVar: spec?.firstPartyEnvFallback,
          });
        } catch (error) {
          const { state } = await this.integration.snapshot();
          throw new Error(
            `Integration "${definition.slug}" (account "${params.account}") could not get its ` +
              `"${slug}" Secret (connection: ${state.connection.status}). Connect the account` +
              (spec?.firstPartyEnvFallback ? ` or set ${spec.firstPartyEnvFallback}.` : "."),
            { cause: error },
          );
        }
      },
    });
    return await replayPathCall(sdk, input);
  }

  async ensureReady() {
    const params = await this.ensureParams();
    await this.ensureIntegrationSubscription(params);
    await waitForProcessorCatchUp({
      consumes: this.integration.contract.consumes,
      snapshot: () => this.integration.snapshot(),
      stream: await this.integrationStream(params),
    });
    return await this.integration.snapshot();
  }

  private async integrationStream(params: IntegrationDurableObjectStructuredName) {
    return await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: integrationAccountStreamPath(params.integration, params.account),
    });
  }

  private async ensureIntegrationSubscription(params: IntegrationDurableObjectStructuredName) {
    const stream = await this.integrationStream(params);
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `integration-subscription:${params.projectId}:${params.integration}:${params.account}`,
      payload: {
        subscriptionKey: `integration:${params.projectId}:${params.integration}:${params.account}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "INTEGRATION",
          durableObjectName: getIntegrationDurableObjectName(params),
          processorName: IntegrationProcessorContract.slug,
        }),
      },
    });
  }
}
