// Pure naming helpers for integration Durable Objects — no DO module imports
// so Node-side code can derive names without cloudflare:workers.

import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export function getIntegrationIngressDurableObjectName(input: { integration: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { integration: input.integration },
  });
}

/** One DO per integration ACCOUNT — the (project, integration, account)
 * triple is the instance. */
export function getIntegrationDurableObjectName(input: {
  account: string;
  integration: string;
  projectId: string;
}) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: {
      account: input.account,
      integration: input.integration,
      projectId: input.projectId,
    },
  });
}

/** One gateway connection per scope: "first-party" for the deployment-level
 * bot, "project:{projectId}:{account}" for a customer-owned bot. */
export function getDiscordGatewayDurableObjectName(input: { scope: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { scope: input.scope },
  });
}
