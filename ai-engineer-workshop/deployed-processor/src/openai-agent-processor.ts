import OpenAI from "openai";
import type { EasyInputMessage, ResponseInput } from "openai/resources/responses/responses";
import { defineProcessor } from "ai-engineer-workshop/runtime";

const DEFAULT_OPENAI_MODEL = "gpt-5.4";

type ConversationMessage = Pick<EasyInputMessage, "content" | "role"> & {
  role: "assistant" | "user";
  type: "message";
};

type AgentState = {
  history: ConversationMessage[];
  pendingResponseOffset?: number;
  requestInProgress: boolean;
};

export function createOpenAiAgentProcessor({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
}: {
  apiKey: string;
  model?: string;
}) {
  const openai = new OpenAI({ apiKey });

  return defineProcessor<AgentState>(() => ({
    slug: `openai-agent:${model}`,
    initialState: {
      history: [],
      pendingResponseOffset: undefined,
      requestInProgress: false,
    },
    reduce: ({ event, state }) => {
      if (event.type === "user-message") {
        const content = getEventContent(event.payload);
        if (content == null) {
          return state;
        }

        return {
          history: [...state.history, createConversationMessage("user", content)],
          pendingResponseOffset: state.requestInProgress
            ? state.pendingResponseOffset
            : event.offset,
          requestInProgress: true,
        };
      }

      if (event.type === "assistant-message") {
        const content = getEventContent(event.payload);
        if (content == null) {
          return state;
        }

        return {
          history: [...state.history, createConversationMessage("assistant", content)],
          pendingResponseOffset: undefined,
          requestInProgress: false,
        };
      }

      if (event.type === "openai-response-error") {
        return {
          ...state,
          pendingResponseOffset: undefined,
          requestInProgress: false,
        };
      }

      return state;
    },
    afterAppend: async ({ append, event, state }) => {
      if (event.type !== "user-message" || state.pendingResponseOffset !== event.offset) {
        return;
      }

      console.log("[openai-agent] starting response", {
        offset: event.offset,
        messageCount: state.history.length,
      });

      try {
        const response = await openai.responses.create({
          model,
          input: toResponseInput(state.history),
        });

        await append({
          event: {
            type: "openai-response-output",
            payload: {
              responseId: response.id,
              outputText: response.output_text,
            },
          },
        });

        if (response.output_text.trim().length > 0) {
          await append({
            event: {
              type: "assistant-message",
              payload: {
                content: response.output_text,
                responseId: response.id,
              },
            },
          });
        }

        console.log("[openai-agent] completed response", {
          offset: event.offset,
          responseId: response.id,
        });
      } catch (error) {
        console.error("[openai-agent] failed to create response", {
          offset: event.offset,
          error,
        });

        await append({
          event: {
            type: "openai-response-error",
            payload: {
              message: getErrorMessage(error),
            },
          },
        });
      }
    },
  }));
}

function createConversationMessage(
  role: ConversationMessage["role"],
  content: string,
): ConversationMessage {
  return {
    role,
    content,
    type: "message",
  };
}

function getEventContent(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload != null &&
    "content" in payload &&
    typeof payload.content === "string"
  ) {
    return payload.content;
  }

  return null;
}

function toResponseInput(history: ConversationMessage[]): ResponseInput {
  return history.map((message) => ({ ...message }));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
