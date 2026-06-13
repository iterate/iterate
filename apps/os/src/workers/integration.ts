/**
 * Integration worker: one DO per (project, integration, account) — runs the
 * connect choreography and the per-account stream processors (including the
 * Slack thread router, which prewarms the AGENT / SLACK_AGENT hosts).
 */
export { IntegrationDurableObject } from "~/domains/integrations/durable-objects/integration-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-integration" }, { status: 404 }),
};
