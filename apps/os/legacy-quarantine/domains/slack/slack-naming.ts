// Pure naming helpers for the Slack domain's Durable Objects. Kept free of any
// DO module imports so Node-side code (e2e tests, CLIs) can derive DO names
// without dragging `cloudflare:workers` into its module graph.

import { formatDurableObjectName } from "~/domains/durable-object-names.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-stream-constants.ts";

export function getSlackIntegrationDurableObjectName(projectId: string) {
  return formatDurableObjectName({ path: SLACK_INTEGRATION_STREAM_PATH, projectId });
}
