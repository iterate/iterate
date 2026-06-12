// The ONE connect choreography every integration shares — the symmetric heart
// of the domain. Whether the credentials came from a first-party OAuth
// callback, a customer's own app registration, or a CLI paste, connecting an
// integration is exactly three appends:
//
//   1. each provided credential  → `secret/set`            on {project}:/secrets/{slug}/{account}/{name}
//   2. the connection itself     → `integration/connected`  on {project}:/integrations/{slug}/{account}
//   3. each routing-key claim    → `integration/route-registered`
//                                                           on {global}:/integrations/{slug}/webhooks
//
// The ACCOUNT is the instance dimension: connecting a second Google account is
// the same three appends under a different account name.
//
// Disconnect is the mirror image (`integration/disconnected` +
// `integration/route-removed`). Provider OAuth callbacks should reduce to
// "exchange the code, then call connectIntegration".

import { env } from "cloudflare:workers";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import {
  DEFAULT_INTEGRATION_ACCOUNT,
  integrationAccountStreamPath,
  integrationIngressStreamPath,
} from "~/domains/integrations/integration-events.ts";
import { ensureIntegrationIngressStub } from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
import { ensureIntegrationStub } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import {
  setJournaledSecret,
  type SetJournaledSecretInput,
} from "~/domains/secrets/secret-streams.ts";

type IntegrationStreamsEnv = {
  GLOBAL_STREAM_NAMESPACE: string;
  STREAM: StreamDurableObjectNamespace;
};

export type ConnectIntegrationInput = {
  integration: string;
  /** The instance name — omit for the unnamed single-account case. */
  account?: string;
  projectId: string;
  ownership: "first-party" | "customer";
  /** Provider-side identity of the connection (installation id, guild id…). */
  externalId: string;
  displayName?: string;
  /** Routing keys this account claims (e.g. ["installation:123"]). */
  routingKeys: string[];
  /** Secrets this account provides, by PROVIDED-SECRET NAME (the definition's
   * providedSecrets); slugs compose as {integration}/{account}/{name}. */
  secrets: (Omit<SetJournaledSecretInput, "projectId" | "slug" | "source"> & { name: string })[];
};

export async function connectIntegration(input: ConnectIntegrationInput) {
  const definition = getIntegration(input.integration);
  const account = input.account ?? DEFAULT_INTEGRATION_ACCOUNT;
  const streamsEnv = env as unknown as IntegrationStreamsEnv;

  // 1. Provided secrets — the integration acting as a secret provider.
  const providedSecretSlugs: string[] = [];
  for (const { name, ...secret } of input.secrets) {
    const slug = providedSecretSlug({ integration: definition.slug, account, name });
    providedSecretSlugs.push(slug);
    await setJournaledSecret({
      ...secret,
      slug,
      projectId: input.projectId,
      source: { kind: "integration-connect", integration: definition.slug, account },
    });
  }

  // 2. The account's lifecycle event.
  const accountStream = await getInitializedStreamStub({
    durableObjectNamespace: streamsEnv.STREAM,
    namespace: input.projectId,
    path: integrationAccountStreamPath(definition.slug, account),
  });
  await accountStream.append({
    type: "events.iterate.com/integration/connected",
    idempotencyKey: `integration-connected:${definition.slug}:${account}:${input.externalId}:${crypto.randomUUID()}`,
    payload: {
      integration: definition.slug,
      account,
      projectId: input.projectId,
      ownership: input.ownership,
      externalId: input.externalId,
      ...(input.displayName == null ? {} : { displayName: input.displayName }),
      routingKeys: input.routingKeys,
      providedSecretSlugs,
    },
  });

  // 3. Routing-key claims on the global capture stream.
  const ingressStream = await getInitializedStreamStub({
    durableObjectNamespace: streamsEnv.STREAM,
    namespace: streamsEnv.GLOBAL_STREAM_NAMESPACE,
    path: integrationIngressStreamPath(definition.slug),
  });
  for (const routingKey of input.routingKeys) {
    await ingressStream.append({
      type: "events.iterate.com/integration/route-registered",
      idempotencyKey: `integration-route:${definition.slug}:${routingKey}:${input.projectId}:${account}`,
      payload: {
        integration: definition.slug,
        routingKey,
        projectId: input.projectId,
        account,
      },
    });
  }

  // Wake both domain objects so subscriptions land before the first provider event.
  await ensureIntegrationStub({
    account,
    integration: definition.slug,
    projectId: input.projectId,
  });
  await ensureIntegrationIngressStub(definition.slug);

  return { integration: definition.slug, account, projectId: input.projectId };
}
