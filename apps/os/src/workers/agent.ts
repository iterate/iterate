/**
 * Agent worker: agent Durable Objects (chat/LLM/agent-host stream
 * processors). The agent-host processor runs itx scripts and dials
 * capabilities through ctx.exports, so the full loopback surface lives here
 * too.
 */
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export * from "./shared/loopback-exports.ts";

export default {
  fetch: () => Response.json({ worker: "os-agent" }, { status: 404 }),
};
