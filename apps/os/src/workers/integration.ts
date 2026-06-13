/**
 * Integration worker: one DO per (project, integration, account) — runs the
 * connect choreography and the per-account stream processors (including the
 * Slack thread router, which prewarms the AGENT / SLACK_AGENT hosts).
 *
 * Registry integration SDKs (itx.integrations.github.octokit, Slack/Discord/
 * Gmail) authenticate with getSecret placeholders and leave through the
 * terminal EgressPipe, which the DO dials via ctx.exports — so this worker
 * re-exports the full loopback surface too.
 */
export { IntegrationDurableObject } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
export * from "./shared/loopback-exports.ts";

export default {
  fetch: () => Response.json({ worker: "os-integration" }, { status: 404 }),
};
