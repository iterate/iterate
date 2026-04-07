import type { ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";

export const agentInputAddedType = "agent-input-added" as const;
export const agentOutputAddedType = "agent-output-added" as const;
export const agentRequestFailedType = "agent-request-failed" as const;

export const AgentInputAddedPayload = z.object({
  content: z.string().min(1),
});

export const AgentOutputAddedPayload = z.object({
  content: z.string(),
});

export const AgentRequestFailedPayload = z.object({
  message: z.string().min(1),
});

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export function buildResponseInput(args: { conversation: ConversationMessage[] }) {
  return args.conversation.map((message) =>
    message.role === "assistant"
      ? {
          content: message.content,
          phase: "final_answer" as const,
          role: "assistant" as const,
        }
      : {
          content: message.content,
          role: "user" as const,
        },
  ) satisfies ResponseInput;
}

export function extractBashBlocks(outputText: string) {
  return [...outputText.matchAll(/```(?:bash|sh|shell)\s*([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((content) => content.length > 0);
}
