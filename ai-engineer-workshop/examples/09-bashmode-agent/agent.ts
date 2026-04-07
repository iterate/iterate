import OpenAI from "openai";
import { defineProcessor, type ProcessorAppendInput } from "ai-engineer-workshop";
import {
  AgentInputAddedPayload,
  AgentOutputAddedPayload,
  agentInputAddedType,
  agentOutputAddedType,
  agentRequestFailedType,
  buildResponseInput,
  type ConversationMessage,
  extractBashBlocks,
} from "./agent-types.ts";
import { buildBashmodeAgentSystemPrompt } from "./prompt.ts";

type AgentState = {
  conversation: ConversationMessage[];
};

type ActiveRequest = {
  controller: AbortController;
};

export function createAgentProcessor({
  agentPath,
  apiKey,
  model,
  systemPrompt,
}: {
  agentPath: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
}) {
  const finalSystemPrompt = systemPrompt ?? buildBashmodeAgentSystemPrompt({ agentPath });

  let activeRequest: ActiveRequest | null = null;

  const processor = defineProcessor<AgentState>(() => ({
    slug: "bashmode-agent",
    initialState: {
      conversation: [],
    },

    reduce: ({ event, state }) => {
      if (event.type === agentInputAddedType) {
        const input = AgentInputAddedPayload.safeParse(event.payload);
        if (!input.success) return state;

        return {
          conversation: [...state.conversation, { role: "user", content: input.data.content }],
        };
      }

      if (event.type === agentOutputAddedType) {
        const output = AgentOutputAddedPayload.safeParse(event.payload);
        if (!output.success) return state;

        return {
          conversation: [
            ...state.conversation,
            { role: "assistant", content: output.data.content },
          ],
        };
      }

      return state;
    },

    afterAppend: async ({ append, event, state }) => {
      if (event.type !== agentInputAddedType) return;
      if (!AgentInputAddedPayload.safeParse(event.payload).success) return;

      activeRequest?.controller.abort();

      const controller = new AbortController();
      activeRequest = { controller };

      void runAgentRequest({
        apiKey,
        append,
        controller,
        conversation: state.conversation,
        model,
        onSettled: () => {
          if (activeRequest?.controller === controller) {
            activeRequest = null;
          }
        },
        systemPrompt: finalSystemPrompt,
      });
    },
  }));

  return Object.assign(processor, {
    stop() {
      activeRequest?.controller.abort();
      activeRequest = null;
    },
  });
}

async function runAgentRequest({
  apiKey,
  append,
  controller,
  conversation,
  model,
  onSettled,
  systemPrompt,
}: {
  apiKey: string;
  append: (input: ProcessorAppendInput) => unknown;
  controller: AbortController;
  conversation: ConversationMessage[];
  model: string;
  onSettled: () => void;
  systemPrompt: string;
}) {
  const openAi = new OpenAI({
    apiKey,
    defaultHeaders: {
      connection: "close",
    },
  });

  try {
    const response = await openAi.responses.create(
      {
        input: buildResponseInput({ conversation }),
        instructions: systemPrompt,
        model,
      },
      {
        signal: controller.signal,
      },
    );

    const outputText = response.output_text;

    await append({
      event: {
        type: agentOutputAddedType,
        payload: {
          content: outputText,
        },
      },
    });

    for (const content of extractBashBlocks(outputText)) {
      await append({
        event: {
          type: "bashmode-block-added",
          payload: {
            content,
          },
        },
      });
    }
  } catch (error) {
    if (!isAbortError(error)) {
      await append({
        event: {
          type: agentRequestFailedType,
          payload: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  } finally {
    onSettled();
  }
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}
