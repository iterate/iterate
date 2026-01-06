import { tool } from "@opencode-ai/plugin";

const TWO_SERVER_URL = process.env.TWO_SERVER_URL ?? "http://localhost:3000";

export const harness_getAgentName = tool({
  description:
    "Get the current agent's ID. Use this to identify yourself when communicating with other agents.",
  args: {},
  async execute(_args, context) {
    const response = await fetch(`${TWO_SERVER_URL}/internal/session-mapping/${context.sessionID}`);
    if (!response.ok) {
      return `Unable to determine agent ID (session: ${context.sessionID})`;
    }
    const data = (await response.json()) as { agentId: string };
    return `Your agent ID is: ${data.agentId}`;
  },
});

export const harness_messageAgent = tool({
  description:
    "Send a message to another agent. The message will be delivered to their event queue and they will process it asynchronously.",
  args: {
    agentName: tool.schema.string().describe("The target agent's name/ID"),
    message: tool.schema.string().describe("The message to send to the agent"),
  },
  async execute(args, _context) {
    const response = await fetch(`${TWO_SERVER_URL}/agents/${args.agentName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "agent_message",
        payload: {
          text: args.message,
          fromAgent: _context.sessionID,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Failed to send message to ${args.agentName}: ${response.status} - ${errorText}`;
    }

    return `Message successfully sent to agent "${args.agentName}"`;
  },
});

export const harness_getSecret = tool({
  description:
    "Retrieve a secret or configuration value. Common secrets include API keys, database credentials, etc.",
  args: {
    key: tool.schema
      .string()
      .describe("The secret key to retrieve (e.g., 'DATABASE_URL', 'API_KEY')"),
  },
  async execute(args, _context) {
    const value = process.env[args.key];
    if (value) {
      return `Secret "${args.key}": ${value}`;
    }

    const response = await fetch(`${TWO_SERVER_URL}/internal/secrets/${args.key}`);
    if (response.ok) {
      const data = (await response.json()) as { value: string };
      return `Secret "${args.key}": ${data.value}`;
    }

    return `Secret "${args.key}" not found`;
  },
});

export const harness_listAgents = tool({
  description: "List all known agents in the system along with their status.",
  args: {},
  async execute(_args, _context) {
    const response = await fetch(`${TWO_SERVER_URL}/internal/agents`);
    if (!response.ok) {
      return "Failed to list agents";
    }
    const data = (await response.json()) as Array<{ name: string; createdAt: string }>;
    if (data.length === 0) {
      return "No agents found";
    }
    return `Known agents:\n${data.map((a) => `- ${a.name} (created: ${a.createdAt})`).join("\n")}`;
  },
});

export const harness_sendMessageToUser = tool({
  description:
    "Send a message back to the user who initiated this conversation. Use this to reply to the user's questions or requests.",
  args: {
    message: tool.schema.string().describe("The message to send to the user"),
  },
  async execute(args, context) {
    const mappingResponse = await fetch(
      `${TWO_SERVER_URL}/internal/session-mapping/${context.sessionID}`,
    );
    if (!mappingResponse.ok) {
      return `Failed to find agent for session ${context.sessionID}`;
    }
    const { agentId } = (await mappingResponse.json()) as { agentId: string };

    const response = await fetch(`${TWO_SERVER_URL}/agents/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "outgoing_message",
        payload: {
          text: args.message,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Failed to send message to user: ${response.status} - ${errorText}`;
    }

    return `Message sent to user: "${args.message}"`;
  },
});
