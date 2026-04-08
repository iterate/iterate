import OpenAI from "openai";
import type { ResponseInputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import { defineProcessor } from "ai-engineer-workshop";
import { match } from "schematch";
import { z } from "zod";

export const AgentInputAddedEvent = z.object({
  type: z.literal("agent-input-added"),
  payload: z.object({
    content: z.string().min(1),
  }),
});

export const OpenAiResponseEventAddedEvent = z.object({
  type: z.literal("openai-response-event-added"),
  payload: z.custom<ResponseStreamEvent>(),
});

export const OpenAiResponseCompletedPayload = z.object({
  type: z.literal("response.completed"),
  response: z.object({
    output: z.array(z.unknown()),
  }),
});

export const OpenAiAssistantMessageOutput = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.unknown()),
});

export const OpenAiOutputText = z.object({
  type: z.literal("output_text"),
  text: z.string(),
});

export type AgentState = {
  history: ResponseInputItem[];
  systemPrompt: string;
  model: string;
};

const initialState: AgentState = {
  history: [],
  systemPrompt: "You are a helpful assistant that likes to joke.",
  model: "gpt-5.4",
};

const dynamicWorkerOpenAiApiKey = "getIterateSecret({secretKey: 'dynamic_worker_openai_api_key'})";

export const agentProcessor = defineProcessor<AgentState>(() => {
  return {
    slug: "agent",
    initialState,

    reduce: ({ event, state }) =>
      match(event)
        .case(AgentInputAddedEvent, ({ payload }) => ({
          ...state,
          history: [...state.history, { role: "user" as const, content: payload.content }],
        }))
        .case(OpenAiResponseEventAddedEvent, ({ payload }) => {
          const outputText = getOutputTextDoneText(payload);

          if (outputText == null) {
            return state;
          }

          return {
            ...state,
            history: [...state.history, { role: "assistant" as const, content: outputText }],
          };
        })
        .default(() => state),

    afterAppend: async ({ append, event, state }) => {
      await match(event)
        .case(AgentInputAddedEvent, async () => {
          const openai = new OpenAI({
            apiKey: getOpenAiApiKey(),
            dangerouslyAllowBrowser: true,
          });
          const response = await openai.responses.create({
            model: state.model,
            instructions: state.systemPrompt,
            input: state.history,
            stream: true,
          });

          for await (const item of response) {
            await append({
              event: { type: "openai-response-event-added", payload: item },
            });

            const outputText = getOutputTextDoneText(item);
            if (outputText == null) continue;

            for (const content of extractBashBlocks(outputText)) {
              await append({
                event: {
                  type: "bashmode-block-added",
                  payload: { content },
                },
              });
            }
          }
        })
        .default(() => undefined);
    },
  };
});

export default agentProcessor;

function getOutputTextDoneText(event: ResponseStreamEvent) {
  if (event.type !== "response.output_text.done") {
    return null;
  }

  return event.text;
}

function extractBashBlocks(outputText: string) {
  return [...outputText.matchAll(/```(?:bash|sh|shell)\s*([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((content) => content.length > 0);
}

function getOpenAiApiKey() {
  const configuredApiKey =
    typeof process === "undefined" ? undefined : process.env.OPENAI_API_KEY?.trim();

  return configuredApiKey && configuredApiKey.length > 0
    ? configuredApiKey
    : dynamicWorkerOpenAiApiKey;
}
