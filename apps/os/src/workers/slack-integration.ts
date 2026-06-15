/**
 * Slack integration worker: one DO per project's Slack integration — routes
 * inbound Slack events onto streams and prewarms the subscribing Durable
 * Objects (AGENT / SLACK_AGENT cross-script namespaces).
 */
export { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-slack-integration" }, { status: 404 }),
};
