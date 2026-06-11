// Integration ingress, two pieces:
//
// 1. captureIntegrationEvent — THE capture primitive. Appends a provider
//    event verbatim to the GLOBAL stream `{global}:/integrations/{slug}/webhooks`
//    and wakes the ingress-router DO behind the ack. Webhook handlers and the
//    Discord gateway DO both call this; everything downstream is
//    transport-blind.
//
// 2. handleIntegrationIngress — the worker hook. Each integration is, from
//    here, just a partial fetch function: try each one, first Response wins.
//    Only the durable capture append gates a webhook 200 (the Slack lesson:
//    providers retry slow webhooks, so nothing cold may sit ahead of the
//    ack); routing to a project happens after, in the router processor.

import { env } from "cloudflare:workers";
import type { RequestContext } from "~/request-context.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { INTEGRATIONS } from "~/domains/integrations/registry.ts";
import {
  integrationIngressStreamPath,
  type IntegrationEventReceivedPayload,
} from "~/domains/integrations/integration-events.ts";
import {
  getIntegrationIngressDurableObjectName,
  getIntegrationIngressStub,
} from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
import type { IntegrationTransport } from "~/domains/integrations/definition.ts";

type IngressEnv = {
  GLOBAL_STREAM_NAMESPACE: string;
  STREAM: StreamDurableObjectNamespace;
};

export async function captureIntegrationEvent(input: {
  integration: string;
  transport: IntegrationTransport;
  routingKey: string | null;
  idempotencyKey: string | null;
  body: unknown;
  /** Wake the router DO behind the ack instead of on the request's critical
   * path. Optional: DO-originated captures (the gateway) just await inline. */
  waitUntil?(promise: Promise<unknown>): void;
}) {
  const ingressEnv = env as unknown as IngressEnv;
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: ingressEnv.STREAM,
    namespace: ingressEnv.GLOBAL_STREAM_NAMESPACE,
    path: integrationIngressStreamPath(input.integration),
  });
  const payload: IntegrationEventReceivedPayload = {
    integration: input.integration,
    transport: input.transport,
    routingKey: input.routingKey,
    body: input.body,
  };
  await stream.append({
    type: "events.iterate.com/integration/event-received",
    idempotencyKey: `${input.integration}-${input.transport}:${
      input.idempotencyKey ?? crypto.randomUUID()
    }`,
    payload,
  });

  const wakeRouter = (async () => {
    const ingress = getIntegrationIngressStub(input.integration);
    await ingress.initialize({
      name: getIntegrationIngressDurableObjectName({ integration: input.integration }),
    });
    await ingress.ensureReady();
  })().catch((error) => {
    console.error(`[${input.integration}-ingress] router catch-up failed`, error);
  });
  if (input.waitUntil) {
    input.waitUntil(wakeRouter);
  } else {
    await wakeRouter;
  }
}

export async function handleIntegrationIngress(input: {
  context: RequestContext;
  request: Request;
}): Promise<Response | null> {
  for (const integration of Object.values(INTEGRATIONS)) {
    if (!integration.fetch) continue;
    const response = await integration.fetch({
      request: input.request,
      env: env as unknown as Record<string, string | undefined>,
      capture: (event) =>
        captureIntegrationEvent({
          ...event,
          integration: integration.slug,
          waitUntil: input.context.waitUntil,
        }),
    });
    if (response) return response;
  }
  return null;
}
