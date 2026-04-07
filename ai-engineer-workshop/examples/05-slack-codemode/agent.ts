import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { defineProcessor, type ProcessorAppendInput } from "ai-engineer-workshop";
import {
  type LlmConversationMessage,
  buildConversationInput,
  formatEventAsPromptInput,
  isAgentEventType,
  llmInputAddedType,
  llmRequestCanceledType,
  llmRequestCompletedType,
  llmRequestFailedType,
  llmRequestStartedType,
  openAiResponseEventAddedType,
  readLlmInput,
  readOutputText,
  shouldMirrorEventToLlmInput,
  toJsonObject,
} from "./agent-types.ts";
import { buildCodingAgentSystemPrompt } from "./coding-agent-system-prompt.ts";
import { codemodeBlockAddedType, extractTypeScriptBlocks } from "./codemode-types.ts";

const model = "gpt-5.4";

export function createSlackAgentProcessor({
  apiKey,
  baseUrl,
  codemodeRootDirectory,
  projectSlug,
  streamPath,
  workingDirectory,
}: {
  apiKey: string;
  baseUrl: string;
  codemodeRootDirectory: string;
  projectSlug: string;
  streamPath: string;
  workingDirectory: string;
}) {
  const instructions = buildCodingAgentSystemPrompt({
    agentPath: streamPath,
    baseUrl,
    codemodeRootDirectory,
    projectSlug,
    workingDirectory,
  });
  const openAi = new OpenAI({ apiKey, defaultHeaders: { connection: "close" } });
  let activeRequest: { controller: AbortController; requestId: string } | null = null;

  const processor = defineProcessor<LlmConversationMessage[]>(() => ({
    slug: "slack-codemode-agent",
    initialState: [],

    reduce: ({ event, state }) => {
      if (event.type === llmInputAddedType) {
        const input = readLlmInput(event.payload);
        return input == null ? state : [...state, { role: "user", content: input.content }];
      }

      if (event.type !== llmRequestCompletedType) {
        return state;
      }

      const outputText = readOutputText(event.payload);
      return outputText == null ? state : [...state, { role: "assistant", content: outputText }];
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

      const input = readLlmInput(event.payload);
      if (input == null) {
        return;
      }

      if (activeRequest != null) {
        activeRequest.controller.abort();
        await append({
          event: {
            type: llmRequestCanceledType,
            payload: { replacementInputOffset: event.offset, requestId: activeRequest.requestId },
          },
        });
      }

      const requestId = randomUUID();
      activeRequest = { controller: new AbortController(), requestId };

      await append({
        event: {
          type: llmRequestStartedType,
          payload: { inputOffset: event.offset, inputSource: input.source, requestId },
        },
      });

      void runRequest({
        append,
        conversation: state,
        controller: activeRequest.controller,
        instructions,
        onDone: () => {
          if (activeRequest?.requestId === requestId) {
            activeRequest = null;
          }
        },
        openAi,
        requestId,
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

export const createAgentProcessor = createSlackAgentProcessor;

async function runRequest({
  append,
  conversation,
  controller,
  instructions,
  onDone,
  openAi,
  requestId,
}: {
  append: (input: ProcessorAppendInput) => unknown;
  conversation: LlmConversationMessage[];
  controller: AbortController;
  instructions: string;
  onDone: () => void;
  openAi: OpenAI;
  requestId: string;
}) {
  let outputText = "";

  try {
    const stream = await openAi.responses.create(
      {
        input: buildConversationInput(conversation),
        instructions,
        model,
        reasoning: { summary: "auto" },
        stream: true,
      },
      { signal: controller.signal },
    );

    for await (const streamEvent of stream) {
      await append({
        event: {
          type: openAiResponseEventAddedType,
          payload: { event: toJsonObject(streamEvent), requestId },
        },
      });
      if (streamEvent.type === "response.output_text.delta") {
        outputText += streamEvent.delta;
      }
    }

    await append({
      event: { type: llmRequestCompletedType, payload: { outputText, requestId } },
    });

    for (const block of extractTypeScriptBlocks(outputText)) {
      await append({
        event: {
          type: codemodeBlockAddedType,
          payload: { blockId: block.blockId, code: block.code, language: "ts", requestId },
        },
      });
    }
  } catch (error) {
    if (!isAbortError(error)) {
      await append({
        event: {
          type: llmRequestFailedType,
          payload: { message: error instanceof Error ? error.message : String(error), requestId },
        },
      });
    }
  } finally {
    onDone();
  }
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}
