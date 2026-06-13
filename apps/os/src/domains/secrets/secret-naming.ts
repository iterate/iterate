// Pure naming helper for Secret Durable Objects — no DO module imports so
// Node-side code (tests, CLIs) can derive names without cloudflare:workers.

import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export function getSecretDurableObjectName(input: { projectId: string; slug: string }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId: input.projectId, slug: input.slug },
  });
}
