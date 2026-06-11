/** Slack agent worker: per-routed-stream Slack delivery DOs. */
export { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-slack-agent" }, { status: 404 }),
};
