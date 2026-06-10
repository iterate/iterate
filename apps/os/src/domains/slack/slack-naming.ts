// Pure naming helpers for the slack domain's Durable Objects. Kept free of any
// DO module imports so Node-side code (e2e tests, CLIs) can derive DO names
// without dragging `cloudflare:workers` into its module graph.

import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export function getSlackIntegrationDurableObjectName(projectId: string) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId },
  });
}
