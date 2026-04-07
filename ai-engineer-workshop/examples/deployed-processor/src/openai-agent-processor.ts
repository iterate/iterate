import OpenAI from "openai";
import type { EasyInputMessage, ResponseInput } from "openai/resources/responses/responses";
import type { StreamProcessor } from "./stream-processor.ts";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

type ConversationMessage = Pick<EasyInputMessage, "content" | "role"> & {
  role: "assistant" | "user";
  type: "message";
};

type AgentState = {
  history: ConversationMessage[];
  requestInProgress: boolean;
};

export function createOpenAiAgentProcessor({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
}: {
  apiKey: string;
  model?: string;
}): StreamProcessor<AgentState> {
  const openai = new OpenAI({ apiKey });

  return {
    initialState: {
      history: [],
      requestInProgress: false,
    },
    reduce: (state, event) => {
      if (event.type === "user-message") {
        const content = getEventContent(event.payload);
        if (content == null) {
          return state;
        }

        return {
          history: [...state.history, createConversationMessage("user", content)],
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
          requestInProgress: false,
        };
      }

      if (event.type === "openai-response-error") {
        return {
          ...state,
          requestInProgress: false,
        };
      }

      return state;
    },
    onEvent: async ({ append, event, state, prevState }) => {
      if (event.type !== "user-message" || prevState.requestInProgress) {
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
          type: "openai-response-output",
          payload: {
            responseId: response.id,
            outputText: response.output_text,
          },
        });

        if (response.output_text.trim().length > 0) {
          await append({
            type: "assistant-message",
            payload: {
              content: response.output_text,
              responseId: response.id,
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
          type: "openai-response-error",
          payload: {
            message: getErrorMessage(error),
          },
        });
      }
    },
  };
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
