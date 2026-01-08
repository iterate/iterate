import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type AppendMessageFn = (
  agentId: string,
  content: unknown,
  source: string,
  metadata?: Record<string, unknown>,
) => Promise<{ offset: string }>;

export interface SlackContext {
  channel?: string;
  threadTs?: string;
  user?: string;
}

export function createCustomTools(
  agentId: string,
  appendMessage: AppendMessageFn,
  slackContext?: SlackContext,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createGetAgentNameTool(agentId),
    createMessageAgentTool(agentId, appendMessage),
    createGetSecretTool(),
  ];

  if (slackContext) {
    tools.push(createSendSlackMessageTool(agentId, appendMessage, slackContext));
  }

  return tools;
}

function createGetAgentNameTool(agentId: string): ToolDefinition {
  return {
    name: "getAgentName",
    label: "Get Agent Name",
    description: "Returns the name/ID of this agent session.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: `Your agent ID is: ${agentId}` }],
      details: { agentId },
    }),
  };
}

function createMessageAgentTool(
  currentAgentId: string,
  appendMessage: AppendMessageFn,
): ToolDefinition {
  const MessageAgentParams = Type.Object({
    agentName: Type.String({ description: "The target agent ID to send the message to" }),
    message: Type.String({ description: "The message content to send" }),
  });

  return {
    name: "messageAgent",
    label: "Message Agent",
    description: "Send a message to another agent.",
    parameters: MessageAgentParams,
    execute: async (_toolCallId: string, params: Static<typeof MessageAgentParams>) => {
      const { agentName, message } = params;
      try {
        await appendMessage(
          agentName,
          {
            type: "agent_message",
            from: currentAgentId,
            text: message,
            timestamp: new Date().toISOString(),
          },
          "agent",
        );

        return {
          content: [{ type: "text", text: `Message sent to agent "${agentName}".` }],
          details: { targetAgent: agentName, from: currentAgentId },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          details: { error: String(error) },
        };
      }
    },
  };
}

function createGetSecretTool(): ToolDefinition {
  return {
    name: "getSecret",
    label: "Get Secret",
    description: "Returns a secret message.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "the singularity is here" }],
      details: {},
    }),
  };
}

function createSendSlackMessageTool(
  agentId: string,
  appendMessage: AppendMessageFn,
  slackContext: SlackContext,
): ToolDefinition {
  const SendSlackMessageParams = Type.Object({
    text: Type.String({ description: "The message text to send to the Slack channel/thread" }),
  });

  return {
    name: "sendSlackMessage",
    label: "Send Slack Message",
    description:
      "Send a message back to the Slack channel/thread that triggered this conversation. Use this to respond to the user.",
    parameters: SendSlackMessageParams,
    execute: async (_toolCallId: string, params: Static<typeof SendSlackMessageParams>) => {
      const { text } = params;

      await appendMessage(
        agentId,
        {
          type: "slack_message_to_send",
          text,
          channel: slackContext.channel,
          threadTs: slackContext.threadTs,
          timestamp: new Date().toISOString(),
        },
        "agent",
        { slackContext },
      );

      return {
        content: [{ type: "text", text: `Message queued to be sent to Slack.` }],
        details: { text, channel: slackContext.channel, threadTs: slackContext.threadTs },
      };
    },
  };
}
