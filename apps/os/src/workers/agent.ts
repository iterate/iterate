/**
 * Agent worker: agent Durable Objects and their stream processors. Agent
 * scripts run through the generic itx processor, so the full loopback surface
 * lives here too.
 */
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export * from "./shared/loopback-exports.ts";

export default {
  fetch: () => Response.json({ worker: "os-agent" }, { status: 404 }),
};
