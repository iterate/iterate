// Pure naming helpers for integration Durable Objects — no DO module imports
// so Node-side code can derive names without cloudflare:workers.

import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export function getIntegrationIngressDurableObjectName(input: { integration: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { integration: input.integration },
  });
}

export function getIntegrationDurableObjectName(input: { integration: string; projectId: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { integration: input.integration, projectId: input.projectId },
  });
}

/** One gateway connection per scope: "first-party" for the deployment-level
 * bot, "project:{projectId}" for a customer-owned bot. */
export function getDiscordGatewayDurableObjectName(input: { scope: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { scope: input.scope },
  });
}
