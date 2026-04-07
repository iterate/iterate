import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { defineProcessor } from "ai-engineer-workshop";
import {
  buildOpenAiInput,
  type ConversationMessage,
  formatEventForLlm,
  isAgentEventType,
  llmInputAddedType,
  llmRequestCompletedType,
  llmRequestStartedType,
  readLlmInput,
  readLlmOutput,
  shouldMirrorToLlmInput,
} from "./agent-types.ts";
import { codemodeBlockAddedType } from "./codemode-types.ts";
import { buildAgentPrompt } from "./prompt.ts";

export function createAgentProcessor({
  apiKey,
  streamPath,
}: {
  apiKey: string;
  streamPath: string;
}) {
  const openAi = new OpenAI({ apiKey, defaultHeaders: { connection: "close" } });
  const instructions = buildAgentPrompt({ agentPath: streamPath });

  return defineProcessor<ConversationMessage[]>(() => ({
    slug: "agent",
    initialState: [],

    reduce: ({ event, state }) => {
      if (event.type === llmInputAddedType) {
        const content = readLlmInput(event.payload);
        return content == null ? state : [...state, { role: "user", content }];
      }

      if (event.type === llmRequestCompletedType) {
        const outputText = readLlmOutput(event.payload);
        return outputText == null ? state : [...state, { role: "assistant", content: outputText }];
      }

      return state;
    },

    async afterAppend({ append, event, state }) {
      if (!isAgentEventType(event.type) && shouldMirrorToLlmInput(event)) {
        await append({
          event: {
            type: llmInputAddedType,
            payload: {
              content: formatEventForLlm(event),
              sourceEventType: event.type,
            },
          },
        });
        return;
      }

      if (event.type !== llmInputAddedType) {
        return;
      }

      await append({
        event: {
          type: llmRequestStartedType,
          payload: { requestId: randomUUID() },
        },
      });

      const response = await openAi.responses.create({
        model: "gpt-5.4",
        reasoning: { summary: "auto" },
        instructions,
        input: buildOpenAiInput(state),
      });
      const outputText = response.output_text ?? "";
      await append({
        event: {
          type: llmRequestCompletedType,
          payload: { outputText },
        },
      });

      for (const [index, code] of extractTypeScriptBlocks(outputText).entries()) {
        await append({
          event: {
            type: codemodeBlockAddedType,
            payload: { blockId: `block-${index + 1}`, code },
          },
        });
      }
    },
  }));
}

function extractTypeScriptBlocks(outputText: string) {
  return [...outputText.matchAll(/```ts\s*([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}
