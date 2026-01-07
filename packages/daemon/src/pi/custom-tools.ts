/**
 * Custom tools that demonstrate harness integration.
 * These tools show that Pi sessions can access context from the surrounding daemon.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type AppendMessageFn = (agentId: string, content: unknown, source: string, metadata?: Record<string, unknown>) => Promise<{ offset: string }>;

/**
 * Create custom tools that are injected with harness context.
 */
export function createCustomTools(agentId: string, appendMessage: AppendMessageFn): ToolDefinition[] {
  return [
    createGetAgentNameTool(agentId),
    createMessageAgentTool(agentId, appendMessage),
    createGetSecretTool(),
  ];
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

function createMessageAgentTool(currentAgentId: string, appendMessage: AppendMessageFn): ToolDefinition {
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
        const promptText = `Message from agent "${currentAgentId}": ${message}`;
        
        // Append a control event that will trigger the Pi session to process the prompt
        await appendMessage(agentName, {
          type: "iterate:control",
          action: "prompt",
          payload: { text: promptText }
        }, "agent:" + currentAgentId);

        return {
          content: [{ type: "text", text: `Message sent to agent "${agentName}".` }],
          details: { targetAgent: agentName, from: currentAgentId },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${error instanceof Error ? error.message : "Unknown error"}` }],
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
