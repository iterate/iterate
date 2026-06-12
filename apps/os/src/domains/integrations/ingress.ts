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
import { parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import { signOAuthState, verifyOAuthState } from "~/domains/secrets/oauth-state.ts";
import { connectIntegration } from "~/domains/integrations/connect.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { INTEGRATIONS } from "~/domains/integrations/registry.ts";
import {
  integrationIngressStreamPath,
  type IntegrationEventReceivedPayload,
} from "~/domains/integrations/integration-events.ts";
import { ensureIntegrationIngressStub } from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
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
    const ingress = await ensureIntegrationIngressStub(input.integration);
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
  const config = parseConfig(env as unknown as Parameters<typeof parseConfig>[0]);
  const baseUrl = config.baseUrl ?? new URL(input.request.url).origin;
  const stateKey = (env as unknown as { SECRETS_ENCRYPTION_KEY?: string }).SECRETS_ENCRYPTION_KEY;
  for (const integration of Object.values(INTEGRATIONS)) {
    if (!integration.fetch) continue;
    const response = await integration.fetch({
      request: input.request,
      env: env as unknown as Record<string, string | undefined>,
      config,
      baseUrl,
      capture: (event) =>
        captureIntegrationEvent({
          ...event,
          integration: integration.slug,
          waitUntil: input.context.waitUntil,
        }),
      oauthState: {
        sign: (payload) => {
          if (!stateKey) throw new Error("SECRETS_ENCRYPTION_KEY is required for OAuth state.");
          return signOAuthState({ key: stateKey, payload, nowMs: Date.now() });
        },
        verify: (state) => {
          if (!stateKey) throw new Error("SECRETS_ENCRYPTION_KEY is required for OAuth state.");
          return verifyOAuthState({ key: stateKey, state, nowMs: Date.now() });
        },
      },
      connect: (connectInput) =>
        connectIntegration({ ...connectInput, integration: integration.slug }),
    });
    if (response) return response;
  }
  return null;
}
