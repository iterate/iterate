// The ONE connect/disconnect choreography every integration shares — the
// symmetric heart of the domain. Whether the credentials came from a
// first-party OAuth callback, a customer's own app registration, or a CLI
// paste, connecting an integration is exactly three appends:
//
//   1. each provided credential  → `secret/set`            on {project}:/secrets/{slug}
//   2. the connection itself     → `integration/connected`  on {project}:/integrations/{slug}
//   3. each routing-key claim    → `integration/route-registered`
//                                                           on {global}:/integrations/{slug}/webhooks
//
// Disconnect is the mirror image. Provider OAuth callbacks should reduce to
// "exchange the code, then call connectIntegration".

import { env } from "cloudflare:workers";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import {
  integrationIngressStreamPath,
  integrationStreamPath,
} from "~/domains/integrations/integration-events.ts";
import {
  getIntegrationIngressDurableObjectName,
  getIntegrationIngressStub,
} from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
import {
  getIntegrationDurableObjectName,
  getIntegrationStub,
} from "~/domains/integrations/durable-objects/integration-durable-object.ts";
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
  projectId: string;
  ownership: "first-party" | "customer";
  /** Provider-side identity of the connection (installation id, guild id…). */
  externalId: string;
  displayName?: string;
  /** Routing keys this connection claims (e.g. ["installation:123"]). */
  routingKeys: string[];
  /** Secrets this connection provides, set through the journaled secret
   * system. Slugs should come from the definition's providedSecrets. */
  secrets: Omit<SetJournaledSecretInput, "projectId" | "source">[];
};

export async function connectIntegration(input: ConnectIntegrationInput) {
  const definition = getIntegration(input.integration);
  const streamsEnv = env as unknown as IntegrationStreamsEnv;

  // 1. Provided secrets — the integration acting as a secret provider.
  for (const secret of input.secrets) {
    await setJournaledSecret({
      ...secret,
      projectId: input.projectId,
      source: { kind: "integration-connect", integration: definition.slug },
    });
  }

  // 2. The project-side lifecycle event.
  const projectStream = await getInitializedStreamStub({
    durableObjectNamespace: streamsEnv.STREAM,
    namespace: input.projectId,
    path: integrationStreamPath(definition.slug),
  });
  await projectStream.append({
    type: "events.iterate.com/integration/connected",
    idempotencyKey: `integration-connected:${definition.slug}:${input.externalId}:${crypto.randomUUID()}`,
    payload: {
      integration: definition.slug,
      projectId: input.projectId,
      ownership: input.ownership,
      externalId: input.externalId,
      ...(input.displayName == null ? {} : { displayName: input.displayName }),
      routingKeys: input.routingKeys,
      providedSecretSlugs: input.secrets.map((secret) => secret.slug),
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
      idempotencyKey: `integration-route:${definition.slug}:${routingKey}:${input.projectId}`,
      payload: { integration: definition.slug, routingKey, projectId: input.projectId },
    });
  }

  // Wake both hosts so subscriptions land before the first provider event.
  const integrationDoName = getIntegrationDurableObjectName({
    integration: definition.slug,
    projectId: input.projectId,
  });
  await getIntegrationStub({
    integration: definition.slug,
    projectId: input.projectId,
  }).initialize({ name: integrationDoName });
  const ingressDoName = getIntegrationIngressDurableObjectName({
    integration: definition.slug,
  });
  await getIntegrationIngressStub(definition.slug).initialize({ name: ingressDoName });

  return { integration: definition.slug, projectId: input.projectId };
}

export async function disconnectIntegration(input: {
  integration: string;
  projectId: string;
  externalId?: string;
  routingKeys: string[];
}) {
  const definition = getIntegration(input.integration);
  const streamsEnv = env as unknown as IntegrationStreamsEnv;

  const projectStream = await getInitializedStreamStub({
    durableObjectNamespace: streamsEnv.STREAM,
    namespace: input.projectId,
    path: integrationStreamPath(definition.slug),
  });
  await projectStream.append({
    type: "events.iterate.com/integration/disconnected",
    idempotencyKey: `integration-disconnected:${definition.slug}:${crypto.randomUUID()}`,
    payload: {
      integration: definition.slug,
      projectId: input.projectId,
      ...(input.externalId == null ? {} : { externalId: input.externalId }),
    },
  });

  const ingressStream = await getInitializedStreamStub({
    durableObjectNamespace: streamsEnv.STREAM,
    namespace: streamsEnv.GLOBAL_STREAM_NAMESPACE,
    path: integrationIngressStreamPath(definition.slug),
  });
  for (const routingKey of input.routingKeys) {
    await ingressStream.append({
      type: "events.iterate.com/integration/route-removed",
      idempotencyKey: `integration-route-removed:${definition.slug}:${routingKey}:${crypto.randomUUID()}`,
      payload: { integration: definition.slug, routingKey },
    });
  }
}
