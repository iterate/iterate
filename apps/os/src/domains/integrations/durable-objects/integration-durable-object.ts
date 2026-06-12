// The integration ACCOUNT, as a domain object: one Durable Object per
// (project, integration, account) — "google" is the type, this DO is "google
// as jonas@nustom.com in this project". It folds
// `{projectId}:/integrations/{slug}/{account}` and implements the itx calling
// convention, so `itx.integrations.{slug}.**` (account "default") and
// `itx.integrations["{slug}/{account}"].**` terminate HERE. The DO is where
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
import {
  getInitializedDoStub,
  listD1ObjectCatalogRecordsByIndex,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
import {
  integrationAccountStreamPath,
  integrationIngressStreamPath,
} from "~/domains/integrations/integration-events.ts";
import {
  getIntegrationDurableObjectName,
  getIntegrationIngressDurableObjectName,
} from "~/domains/integrations/integration-naming.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import {
  IntegrationProcessor,
  IntegrationProcessorContract,
} from "~/domains/integrations/stream-processors/integration/implementation.ts";
import { ensureSecretStub } from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import {
  SlackRouteProcessor,
  SlackRouteProcessorContract,
} from "~/domains/slack/stream-processors/slack-route/implementation.ts";
import { slackRouteProcessorDeps } from "~/domains/slack/slack-route-host.ts";
import {
  GithubRouteProcessor,
  GithubRouteProcessorContract,
} from "~/domains/integrations/stream-processors/github-route/implementation.ts";

export { getIntegrationDurableObjectName };

const IntegrationDurableObjectStructuredName = z.object({
  account: z.string().trim().min(1),
  integration: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});
export type IntegrationDurableObjectStructuredName = z.infer<
  typeof IntegrationDurableObjectStructuredName
>;

/** The accounts of one integration in one project, from the DO catalog. */
export async function listIntegrationAccounts(input: {
  projectId: string;
  integration: string;
}): Promise<string[]> {
  const records = await listD1ObjectCatalogRecordsByIndex<IntegrationDurableObjectStructuredName>(
    (env as unknown as IntegrationEnv).DO_CATALOG,
    {
      className: "IntegrationDurableObject",
      indexName: "projectIntegration",
      indexValue: `${input.projectId}:${input.integration}`,
    },
  );
  return records.map((record) => record.structuredName.account);
}

/**
 * Resolve the account a BARE address means (itx.integrations.slack with no
 * explicit "slug/account"): "default" when it exists, the sole account when
 * there is exactly one (slack accounts are team-derived), otherwise the
 * caller must address the instance explicitly.
 */
export async function resolveImplicitAccount(input: {
  projectId: string;
  integration: string;
}): Promise<string> {
  const accounts = await listIntegrationAccounts(input);
  if (accounts.length === 0 || accounts.includes("default")) return "default";
  if (accounts.length === 1) return accounts[0]!;
  throw new Error(
    `Integration "${input.integration}" has ${accounts.length} accounts (${accounts.join(", ")}) — ` +
      `address one explicitly: itx.integrations["${input.integration}/${accounts[0]}"].`,
  );
}

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
  GLOBAL_STREAM_NAMESPACE: string;
  INTEGRATION: DurableObjectNamespace<IntegrationDurableObject>;
  // The ingress-router namespace is dialed by NAME here (not by module
  // import) to avoid a module cycle: the ingress DO imports this one.
  INTEGRATION_INGRESS: DurableObjectNamespace<
    import("./integration-ingress-durable-object.ts").IntegrationIngressDurableObject
  >;
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
    // Accounts of one integration in one project enumerate from here.
    projectIntegration: (params) => `${params.projectId}:${params.integration}`,
  },
  nameSchema: IntegrationDurableObjectStructuredName,
});

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class IntegrationDurableObject extends IntegrationLifecycleBase<IntegrationEnv> {
  host = createStreamProcessorHost(this.ctx);
  integration = this.host.add(IntegrationProcessorContract.slug, (deps) => {
    return new IntegrationProcessor({
      ...deps,
      // The two cross-boundary capabilities the processor can't reach
      // itself; the connect choreography is processor code.
      claimRoute: async ({ routingKey, takeover }) => {
        const params = await this.ensureParams();
        const ingressStream = await getInitializedStreamStub({
          durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
          namespace: this.env.GLOBAL_STREAM_NAMESPACE,
          path: integrationIngressStreamPath(params.integration),
        });
        await ingressStream.append({
          type: "events.iterate.com/integration/route-registered",
          // Takeovers get their own idempotency lineage so a consented
          // re-claim isn't deduped against the original rejected claim.
          idempotencyKey: `integration-route:${params.integration}:${routingKey}:${params.projectId}:${params.account}${takeover ? ":takeover" : ""}`,
          payload: {
            integration: params.integration,
            routingKey,
            projectId: params.projectId,
            account: params.account,
            ...(takeover === true ? { takeover: true } : {}),
          },
        });
        // Wake the router so the claim folds before the next provider event.
        const ingressName = getIntegrationIngressDurableObjectName({
          integration: params.integration,
        });
        await this.env.INTEGRATION_INGRESS.getByName(ingressName).initialize({
          name: ingressName,
        });
      },
      ensureSecretHost: async ({ slug }) => {
        const params = await this.ensureParams();
        const stub = await ensureSecretStub({ projectId: params.projectId, slug });
        await stub.ensureReady();
      },
      // The generic fan-out seam stays open; provider-specific fan-out is a
      // SEPARATE processor on the same stream (slack-route below).
    });
  });

  // Provider-specific fan-out processors share the account stream. Slack is
  // the only provider with one today; per conventions-over-frameworks this is
  // a direct registration, not a plugin mechanism — a second provider
  // processor earns the abstraction. Deps resolve params lazily because
  // host.add runs at construction, before the DO knows its name.
  slackRoute = this.host.add(SlackRouteProcessorContract.slug, (deps) => {
    const slackDeps = async () => {
      const params = await this.ensureParams();
      return slackRouteProcessorDeps({ projectId: params.projectId, account: params.account });
    };
    return new SlackRouteProcessor({
      ...deps,
      createRoutedStreamBootstrapEvents: async (input) =>
        (await slackDeps()).createRoutedStreamBootstrapEvents!(input),
      acknowledgeRoutedWebhook: async (input) =>
        (await slackDeps()).acknowledgeRoutedWebhook!(input),
      prewarmRoutedStreamHosts: async (input) =>
        (await slackDeps()).prewarmRoutedStreamHosts!(input),
    });
  });

  // GitHub's fan-out: repository webhooks route to the linked repos' streams
  // (the github-route processor; route memory comes from the repo processor's
  // remote-configured reaction).
  githubRoute = this.host.add(
    GithubRouteProcessorContract.slug,
    (deps) => new GithubRouteProcessor(deps),
  );

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
   * The SDK is built fresh per call (a thin client) and holds NO material:
   * its token is a getSecret placeholder and its fetch is the terminal
   * egress pipe, where substitution (with inline derivation) happens — the
   * same convention userspace SDKs use.
   */
  async call(input: PathCall): Promise<unknown> {
    const params = await this.ensureParams();
    const definition = getIntegration(params.integration);
    const sdk = await definition.createSdk({
      projectId: params.projectId,
      account: params.account,
      secretRef: (name) =>
        `getSecret({ key: "${providedSecretSlug({
          integration: definition.slug,
          account: params.account,
          name,
        })}" })`,
      fetch: this.egressFetch(params),
    });
    return await replayPathCall(sdk, input);
  }

  /** The SDKs' outbound door: the SAME terminal egress pipe project code's
   * bare fetch() leaves through, dialed as a loopback. Placeholders
   * substitute there; this DO never holds material. */
  private egressFetch(params: IntegrationDurableObjectStructuredName): typeof fetch {
    const exports = this.ctx.exports as unknown as {
      EgressPipe(options: { props: Record<string, unknown> }): {
        call(input: { path: string[]; args: unknown[] }): Promise<Response>;
      };
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request && init == null ? input : new Request(input, init);
      const pipe = exports.EgressPipe({
        props: {
          projectId: params.projectId,
          capabilityPath: `integrations.${params.integration}/${params.account}`,
        },
      });
      return await pipe.call({ path: [], args: [request] });
    }) as typeof fetch;
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
    const processorSlugs = [
      IntegrationProcessorContract.slug,
      // Provider-specific routers subscribe alongside the generic processor.
      ...(params.integration === "slack" ? [SlackRouteProcessorContract.slug] : []),
      ...(params.integration === "github" ? [GithubRouteProcessorContract.slug] : []),
    ];
    for (const processorName of processorSlugs) {
      await stream.append({
        type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
        idempotencyKey: `integration-subscription:${params.projectId}:${params.integration}:${params.account}:${processorName}`,
        payload: {
          subscriptionKey: `${processorName}:${params.projectId}:${params.integration}:${params.account}`,
          subscriber: durableObjectProcessorSubscriber({
            bindingName: "INTEGRATION",
            durableObjectName: getIntegrationDurableObjectName(params),
            processorName,
          }),
        },
      });
    }
  }
}
