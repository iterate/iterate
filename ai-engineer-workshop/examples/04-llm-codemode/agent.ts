import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { defineProcessor, type ProcessorAppendInput } from "ai-engineer-workshop";
import {
  LlmInputAddedPayload,
  LlmRequestCompletedPayload,
  type LlmConversationMessage,
  buildConversationFromState,
  formatEventAsPromptInput,
  isAgentEventType,
  llmInputAddedType,
  llmRequestCanceledType,
  llmRequestCompletedType,
  llmRequestFailedType,
  llmRequestStartedType,
  openAiResponseEventAddedType,
  shouldMirrorEventToLlmInput,
  toJsonObject,
} from "./agent-types.ts";
import { buildCodingAgentSystemPrompt } from "./coding-agent-system-prompt.ts";
import { codemodeBlockAddedType, extractTypeScriptBlocks } from "./codemode-types.ts";

type AgentState = {
  conversation: LlmConversationMessage[];
  requestInProgress: boolean;
  currentRequestId: string | null;
};

type ActiveRequest = {
  controller: AbortController;
  requestId: string;
};

export function createAgentProcessor({
  agentPath,
  apiKey,
  baseUrl,
  codemodeRootDirectory,
  model,
  projectSlug,
  systemPrompt,
  workingDirectory,
}: {
  agentPath: string;
  apiKey: string;
  baseUrl: string;
  codemodeRootDirectory: string;
  model: string;
  projectSlug: string;
  systemPrompt?: string;
  workingDirectory: string;
}) {
  const finalSystemPrompt =
    systemPrompt ??
    buildCodingAgentSystemPrompt({
      agentPath,
      baseUrl,
      codemodeRootDirectory,
      projectSlug,
      workingDirectory,
    });

  let activeRequest: ActiveRequest | null = null;

  const processor = defineProcessor<AgentState>(() => ({
    slug: "codemode-agent",
    initialState: {
      conversation: [],
      requestInProgress: false,
      currentRequestId: null,
    },

    reduce: ({ event, state }) => {
      if (event.type === llmInputAddedType) {
        const parsed = LlmInputAddedPayload.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }

        return {
          ...state,
          conversation: [...state.conversation, { role: "user", content: parsed.data.content }],
        };
      }

      if (event.type === llmRequestStartedType) {
        return {
          ...state,
          currentRequestId: readRequestId(event.payload) ?? state.currentRequestId,
          requestInProgress: true,
        };
      }

      if (event.type === llmRequestCanceledType || event.type === llmRequestFailedType) {
        return {
          ...state,
          currentRequestId: null,
          requestInProgress: false,
        };
      }

      if (event.type === llmRequestCompletedType) {
        const parsed = LlmRequestCompletedPayload.safeParse(event.payload);
        if (!parsed.success) {
          return {
            ...state,
            currentRequestId: null,
            requestInProgress: false,
          };
        }

        return {
          ...state,
          conversation: [
            ...state.conversation,
            { role: "assistant", content: parsed.data.outputText },
          ],
          currentRequestId: null,
          requestInProgress: false,
        };
      }

      return state;
    },

    afterAppend: async ({ append, event, state }) => {
      if (!isAgentEventType(event.type) && shouldMirrorEventToLlmInput(event)) {
        await append({
          event: {
            type: llmInputAddedType,
            payload: {
              content: formatEventAsPromptInput(event),
              source: "event",
              sourceEventOffset: event.offset,
              sourceEventType: event.type,
            },
          },
        });
        return;
      }

      if (event.type !== llmInputAddedType) {
        return;
      }

      const input = LlmInputAddedPayload.safeParse(event.payload);
      if (!input.success) {
        return;
      }

      if (activeRequest != null) {
        const canceledRequest = activeRequest;
        activeRequest = null;
        canceledRequest.controller.abort();

        await append({
          event: {
            type: llmRequestCanceledType,
            payload: {
              replacementInputOffset: event.offset,
              requestId: canceledRequest.requestId,
            },
          },
        });
      }

      const requestId = randomUUID();
      const controller = new AbortController();
      activeRequest = { controller, requestId };

      await append({
        event: {
          type: llmRequestStartedType,
          payload: {
            inputOffset: event.offset,
            inputSource: input.data.source,
            requestId,
          },
        },
      });

      void runOpenAiRequest({
        apiKey,
        append,
        controller,
        conversation: state.conversation,
        model,
        onSettled: () => {
          if (activeRequest?.requestId === requestId) {
            activeRequest = null;
          }
        },
        requestId,
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

async function runOpenAiRequest({
  apiKey,
  append,
  controller,
  conversation,
  model,
  onSettled,
  requestId,
  systemPrompt,
}: {
  apiKey: string;
  append: (input: ProcessorAppendInput) => unknown;
  controller: AbortController;
  conversation: LlmConversationMessage[];
  model: string;
  onSettled: () => void;
  requestId: string;
  systemPrompt: string;
}) {
  const openAi = new OpenAI({
    apiKey,
    defaultHeaders: {
      connection: "close",
    },
  });
  let outputText = "";

  try {
    const stream = await openAi.responses.create(
      {
        input: buildResponseInput({ conversation }),
        instructions: systemPrompt,
        model,
        stream: true,
      },
      {
        signal: controller.signal,
      },
    );

    for await (const streamEvent of stream) {
      await append({
        event: {
          type: openAiResponseEventAddedType,
          payload: {
            event: toJsonObject(streamEvent),
            requestId,
          },
        },
      });

      if (streamEvent.type === "response.output_text.delta") {
        outputText += streamEvent.delta;
      }
    }

    await append({
      event: {
        type: llmRequestCompletedType,
        payload: {
          outputText,
          requestId,
        },
      },
    });

    for (const block of extractTypeScriptBlocks(outputText)) {
      await append({
        event: {
          type: codemodeBlockAddedType,
          payload: {
            blockId: block.blockId,
            code: block.code,
            language: "ts",
            requestId,
          },
        },
      });
    }
  } catch (error) {
    if (!isAbortError(error)) {
      await append({
        event: {
          type: llmRequestFailedType,
          payload: {
            message: error instanceof Error ? error.message : String(error),
            requestId,
          },
        },
      });
    }
  } finally {
    onSettled();
  }
}

function buildResponseInput({ conversation }: { conversation: LlmConversationMessage[] }) {
  return buildConversationFromState({ conversation }) satisfies ResponseInput;
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}

function readRequestId(payload: unknown) {
  if (typeof payload !== "object" || payload == null || !("requestId" in payload)) {
    return null;
  }

  return String(payload.requestId);
}
