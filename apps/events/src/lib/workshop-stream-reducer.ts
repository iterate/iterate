import type { Event } from "@iterate-com/events-contract";
import type { StreamFeedItem } from "~/lib/stream-feed-types.ts";

const LLM_INPUT_ADDED_TYPE = "llm-input-added" as const;
const LLM_REQUEST_STARTED_TYPE = "llm-request-started" as const;
const LLM_REQUEST_CANCELED_TYPE = "llm-request-canceled" as const;
const LLM_REQUEST_FAILED_TYPE = "llm-request-failed" as const;
const OPENAI_RESPONSE_EVENT_ADDED_TYPE = "openai-response-event-added" as const;
const OPENAI_OUTPUT_ITEM_ADDED_TYPE = "openai-output-item-added" as const;
const LLM_REQUEST_COMPLETED_TYPE = "llm-request-completed" as const;
const CODEMODE_BLOCK_ADDED_TYPE = "codemode-block-added" as const;
const CODEMODE_RESULT_ADDED_TYPE = "codemode-result-added" as const;
const BASHMODE_BLOCK_ADDED_TYPE = "bashmode-block-added" as const;
const AGENT_INPUT_ADDED_TYPE = "agent-input-added" as const;
const AGENT_OUTPUT_ADDED_TYPE = "agent-output-added" as const;
const AGENT_REQUEST_FAILED_TYPE = "agent-request-failed" as const;

type WorkshopInputSource = "user" | "event";

type LlmInputAddedPayload = {
  content: string;
  source: WorkshopInputSource;
};

type LlmRequestStartedPayload = {
  requestId: string;
  inputOffset: number;
  inputSource: WorkshopInputSource;
};

type LlmRequestCanceledPayload = {
  requestId: string;
  replacementInputOffset: number;
};

type LlmRequestFailedPayload = {
  requestId: string;
  message: string;
};

type LlmRequestCompletedPayload = {
  requestId: string;
  outputText: string;
};

type AgentInputAddedPayload = {
  content: string;
};

type AgentOutputAddedPayload = {
  content: string;
};

type AgentRequestFailedPayload = {
  message: string;
};

type OpenAiOutputItemAddedPayload = {
  item: OpenAiAssistantOutputItem;
};

type OpenAiResponseEventAddedPayload = {
  requestId?: string;
  event: OpenAiResponseStreamEvent;
};

type CodemodeBlockAddedPayload = {
  requestId: string;
  blockId: string;
  language: string;
  code: string;
};

type CodemodeResultAddedPayload = {
  requestId: string;
  blockId: string;
  blockCount: number;
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  codePath: string;
  outputPath: string;
};

type BashmodeBlockAddedPayload = {
  content: string;
};

type OpenAiResponseTextDeltaEvent = {
  type: "response.output_text.delta";
  item_id: string;
  content_index: number;
  delta: string;
  output_index?: number;
};

type OpenAiResponseTextDoneEvent = {
  type: "response.output_text.done";
  item_id: string;
  content_index: number;
  text: string;
  output_index?: number;
};

type OpenAiAssistantOutputItem = {
  id: string;
  type: "message";
  role: "assistant";
  content?: unknown[];
};

type OpenAiResponseOutputItemAddedEvent = {
  type: "response.output_item.added";
  output_index: number;
  item: OpenAiAssistantOutputItem;
};

type OpenAiResponseOutputItemDoneEvent = {
  type: "response.output_item.done";
  output_index: number;
  item: OpenAiAssistantOutputItem;
};

type OpenAiResponseCompletedEvent = {
  type: "response.completed";
  response: {
    output?: unknown[];
  };
};

type OpenAiResponseFailedEvent = {
  type: "response.failed";
  response?: {
    error?: {
      message?: string | null;
    } | null;
  };
};

type OpenAiErrorEvent = {
  type: "error";
  message: string;
};

/** Frames an output_text part; text is carried by delta/done events. */
type OpenAiContentPartStreamEvent = {
  type: "response.content_part.added" | "response.content_part.done";
  item_id: string;
  content_index: number;
  output_index: number;
};

type OpenAiResponseStreamEvent =
  | OpenAiResponseTextDeltaEvent
  | OpenAiResponseTextDoneEvent
  | OpenAiResponseOutputItemAddedEvent
  | OpenAiResponseOutputItemDoneEvent
  | OpenAiResponseCompletedEvent
  | OpenAiResponseFailedEvent
  | OpenAiErrorEvent
  | OpenAiContentPartStreamEvent;

type WorkshopOutputMessage = {
  itemId: string;
  outputIndex?: number;
  contentParts: Map<number, string>;
  contentOrder: number[];
  completedText?: string;
  done: boolean;
};

type WorkshopTurn = {
  inputOffset: number;
  inputText: string;
  inputTimestamp: number;
  requestId?: string;
  startedOffset?: number;
  startedTimestamp?: number;
  latestOutputOffset?: number;
  outputTimestamp?: number;
  outputMessages: Map<string, WorkshopOutputMessage>;
  outputMessageOrder: string[];
  completedOffset?: number;
  completedTimestamp?: number;
  completedOutputText?: string;
  canceledOffset?: number;
  canceledTimestamp?: number;
  replacementInputOffset?: number;
  failedOffset?: number;
  failedTimestamp?: number;
  failedMessage?: string;
};

type OutputMessageContainer = {
  outputMessages: Map<string, WorkshopOutputMessage>;
  outputMessageOrder: string[];
};

type StreamingAgentTurn = OutputMessageContainer & {
  inputOffset: number;
  inputTimestamp: number;
  latestOutputOffset?: number;
  outputTimestamp?: number;
  terminalOffset?: number;
  terminalTimestamp?: number;
  failedMessage?: string;
  completedOutputText?: string;
};

function routeOpenAiResponseStreamToWorkshopTurns(
  payload: OpenAiResponseEventAddedPayload,
  event: Event,
  turnsByRequestId: Map<string, WorkshopTurn>,
  pendingStreamingAgentTurns: StreamingAgentTurn[],
) {
  const timestamp = getTimestamp(event.createdAt);
  const turn = payload.requestId == null ? undefined : turnsByRequestId.get(payload.requestId);
  if (turn) {
    turn.latestOutputOffset = event.offset;
    turn.outputTimestamp = timestamp;
    applyOpenAiResponseStreamEvent(turn, payload.event);
    return;
  }

  const streamingAgentTurn = getLatestPendingStreamingAgentTurn(pendingStreamingAgentTurns);
  if (!streamingAgentTurn) {
    return;
  }

  streamingAgentTurn.latestOutputOffset = event.offset;
  streamingAgentTurn.outputTimestamp = timestamp;
  applyOpenAiResponseStreamEventToStreamingAgentTurn(streamingAgentTurn, payload.event);

  if (isTerminalOpenAiResponseStreamEvent(payload.event)) {
    closePendingStreamingAgentTurn(
      pendingStreamingAgentTurns,
      streamingAgentTurn,
      event.offset,
      timestamp,
    );
  }
}

export function buildWorkshopSemanticInsertions(
  events: readonly Event[],
): Map<number, StreamFeedItem[]> {
  const insertionsByOffset = new Map<number, StreamFeedItem[]>();
  const turns: WorkshopTurn[] = [];
  const turnsByInputOffset = new Map<number, WorkshopTurn>();
  const turnsByRequestId = new Map<string, WorkshopTurn>();
  const streamingAgentTurns: StreamingAgentTurn[] = [];
  const pendingStreamingAgentTurns: StreamingAgentTurn[] = [];

  for (const event of events) {
    if (event.type === AGENT_INPUT_ADDED_TYPE) {
      const payload = parseAgentInputAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: payload.content }],
        timestamp: getTimestamp(event.createdAt),
      });

      const turn: StreamingAgentTurn = {
        inputOffset: event.offset,
        inputTimestamp: getTimestamp(event.createdAt),
        outputMessages: new Map<string, WorkshopOutputMessage>(),
        outputMessageOrder: [],
      };

      streamingAgentTurns.push(turn);
      pendingStreamingAgentTurns.push(turn);
      continue;
    }

    if (event.type === AGENT_OUTPUT_ADDED_TYPE) {
      const plainPayload = parseAgentOutputAddedPayload(event.payload);
      if (plainPayload) {
        appendInsertion(insertionsByOffset, event.offset, {
          kind: "message",
          role: "assistant",
          content: [{ type: "text", text: plainPayload.content }],
          timestamp: getTimestamp(event.createdAt),
        });

        closeLatestPendingStreamingAgentTurn(
          pendingStreamingAgentTurns,
          event.offset,
          getTimestamp(event.createdAt),
        );
        continue;
      }

      const openAiPayload = parseOpenAiResponseEventAddedPayload(event.payload);
      if (!openAiPayload) {
        continue;
      }

      routeOpenAiResponseStreamToWorkshopTurns(
        openAiPayload,
        event,
        turnsByRequestId,
        pendingStreamingAgentTurns,
      );
      continue;
    }

    if (event.type === OPENAI_OUTPUT_ITEM_ADDED_TYPE) {
      const payload = parseOpenAiOutputItemAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      const content = extractAssistantTextFromContentItems(payload.item.content);
      if (content.length === 0) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "message",
        role: "assistant",
        content: [{ type: "text", text: content }],
        timestamp: getTimestamp(event.createdAt),
      });

      closeLatestPendingStreamingAgentTurn(
        pendingStreamingAgentTurns,
        event.offset,
        getTimestamp(event.createdAt),
      );
      continue;
    }

    if (event.type === AGENT_REQUEST_FAILED_TYPE) {
      const payload = parseAgentRequestFailedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "error",
        message: "Agent request failed",
        context: payload.message,
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });

      closeLatestPendingStreamingAgentTurn(
        pendingStreamingAgentTurns,
        event.offset,
        getTimestamp(event.createdAt),
      );
      continue;
    }

    if (event.type === BASHMODE_BLOCK_ADDED_TYPE) {
      const payload = parseBashmodeBlockAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "bashmode-block",
        content: payload.content,
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });
      continue;
    }

    if (event.type === LLM_INPUT_ADDED_TYPE) {
      const payload = parseLlmInputAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: payload.content }],
        timestamp: getTimestamp(event.createdAt),
      });

      const turn: WorkshopTurn = {
        inputOffset: event.offset,
        inputText: payload.content,
        inputTimestamp: getTimestamp(event.createdAt),
        outputMessages: new Map<string, WorkshopOutputMessage>(),
        outputMessageOrder: [],
      };

      turns.push(turn);
      turnsByInputOffset.set(event.offset, turn);
      continue;
    }

    if (event.type === LLM_REQUEST_STARTED_TYPE) {
      const payload = parseLlmRequestStartedPayload(event.payload);
      if (!payload) {
        continue;
      }

      const turn = turnsByInputOffset.get(payload.inputOffset);
      if (!turn) {
        continue;
      }

      turn.requestId = payload.requestId;
      turn.startedOffset = event.offset;
      turn.startedTimestamp = getTimestamp(event.createdAt);
      turnsByRequestId.set(payload.requestId, turn);

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "stream-lifecycle",
        label: "LLM request started",
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });
      continue;
    }

    if (event.type === LLM_REQUEST_CANCELED_TYPE) {
      const payload = parseLlmRequestCanceledPayload(event.payload);
      if (!payload) {
        continue;
      }

      const turn = turnsByRequestId.get(payload.requestId);
      if (!turn) {
        continue;
      }

      turn.canceledOffset = event.offset;
      turn.canceledTimestamp = getTimestamp(event.createdAt);
      turn.replacementInputOffset = payload.replacementInputOffset;

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "stream-lifecycle",
        label: "LLM request canceled",
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });
      continue;
    }

    if (event.type === LLM_REQUEST_FAILED_TYPE) {
      const payload = parseLlmRequestFailedPayload(event.payload);
      if (!payload) {
        continue;
      }

      const turn = turnsByRequestId.get(payload.requestId);
      if (!turn) {
        continue;
      }

      turn.failedOffset = event.offset;
      turn.failedTimestamp = getTimestamp(event.createdAt);
      turn.failedMessage = payload.message;
      continue;
    }

    if (event.type === OPENAI_RESPONSE_EVENT_ADDED_TYPE) {
      const payload = parseOpenAiResponseEventAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      routeOpenAiResponseStreamToWorkshopTurns(
        payload,
        event,
        turnsByRequestId,
        pendingStreamingAgentTurns,
      );
      continue;
    }

    if (event.type === LLM_REQUEST_COMPLETED_TYPE) {
      const payload = parseLlmRequestCompletedPayload(event.payload);
      if (!payload) {
        continue;
      }

      const turn = turnsByRequestId.get(payload.requestId);
      if (!turn) {
        continue;
      }

      turn.completedOffset = event.offset;
      turn.completedTimestamp = getTimestamp(event.createdAt);
      turn.completedOutputText = payload.outputText;
      continue;
    }

    if (event.type === CODEMODE_BLOCK_ADDED_TYPE) {
      const payload = parseCodemodeBlockAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "codemode-block",
        requestId: payload.requestId,
        blockId: payload.blockId,
        language: payload.language,
        code: payload.code,
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });
      continue;
    }

    if (event.type === CODEMODE_RESULT_ADDED_TYPE) {
      const payload = parseCodemodeResultAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "codemode-result",
        requestId: payload.requestId,
        blockId: payload.blockId,
        blockCount: payload.blockCount,
        success: payload.success,
        exitCode: payload.exitCode,
        stdout: payload.stdout,
        stderr: payload.stderr,
        durationMs: payload.durationMs,
        codePath: payload.codePath,
        outputPath: payload.outputPath,
        timestamp: getTimestamp(event.createdAt),
        raw: event,
      });
    }
  }

  for (const turn of turns) {
    const timestamp =
      turn.completedTimestamp ??
      turn.failedTimestamp ??
      turn.canceledTimestamp ??
      turn.outputTimestamp ??
      turn.startedTimestamp ??
      turn.inputTimestamp;
    const messageOffset =
      turn.completedOffset ??
      turn.failedOffset ??
      turn.canceledOffset ??
      turn.latestOutputOffset ??
      turn.startedOffset ??
      turn.inputOffset;
    const requestFinished =
      turn.completedOffset != null || turn.failedOffset != null || turn.canceledOffset != null;
    const assistantMessages = buildWorkshopAssistantMessages({
      requestFinished,
      timestamp,
      turn,
    });

    for (const assistantMessage of assistantMessages) {
      appendInsertion(insertionsByOffset, messageOffset, assistantMessage);
    }

    if (turn.failedMessage) {
      appendInsertion(insertionsByOffset, turn.failedOffset ?? messageOffset, {
        kind: "error",
        message: "LLM request failed",
        context: turn.failedMessage,
        timestamp: turn.failedTimestamp ?? timestamp,
        raw: {
          inputOffset: turn.inputOffset,
          inputText: turn.inputText,
          requestId: turn.requestId,
          message: turn.failedMessage,
        },
      });
    }
  }

  for (const turn of streamingAgentTurns) {
    const timestamp = turn.terminalTimestamp ?? turn.outputTimestamp ?? turn.inputTimestamp;
    const messageOffset = turn.terminalOffset ?? turn.latestOutputOffset ?? turn.inputOffset;
    const requestFinished = turn.terminalOffset != null;
    const assistantMessages = buildStreamingAgentAssistantMessages({
      requestFinished,
      timestamp,
      turn,
    });

    for (const assistantMessage of assistantMessages) {
      appendInsertion(insertionsByOffset, messageOffset, assistantMessage);
    }

    if (turn.failedMessage) {
      appendInsertion(insertionsByOffset, turn.terminalOffset ?? messageOffset, {
        kind: "error",
        message: "Agent request failed",
        context: turn.failedMessage,
        timestamp: turn.terminalTimestamp ?? timestamp,
        raw: {
          inputOffset: turn.inputOffset,
          message: turn.failedMessage,
        },
      });
    }
  }

  return insertionsByOffset;
}

function applyOpenAiResponseStreamEvent(turn: WorkshopTurn, event: OpenAiResponseStreamEvent) {
  if (event.type === "response.content_part.added" || event.type === "response.content_part.done") {
    return;
  }

  if (event.type === "response.output_item.added") {
    registerAssistantOutputItem(turn, event.item, event.output_index);
    return;
  }

  if (event.type === "response.output_item.done") {
    const outputMessage = registerAssistantOutputItem(turn, event.item, event.output_index);
    if (outputMessage == null) {
      return;
    }
    const completedText = extractAssistantTextFromContentItems(event.item.content);
    if (completedText.length > 0) {
      outputMessage.completedText = completedText;
    }
    outputMessage.done = true;
    return;
  }

  if (event.type === "response.output_text.delta") {
    const outputMessage = getOrCreateOutputMessage(turn, {
      itemId: event.item_id,
      outputIndex: event.output_index,
    });
    setOutputMessageTextPart(
      outputMessage,
      event.content_index,
      getExistingOutputMessageTextPart(outputMessage, event.content_index) + event.delta,
    );
    return;
  }

  if (event.type === "response.output_text.done") {
    const outputMessage = getOrCreateOutputMessage(turn, {
      itemId: event.item_id,
      outputIndex: event.output_index,
    });
    setOutputMessageTextPart(outputMessage, event.content_index, event.text);
    return;
  }

  if (event.type === "response.completed") {
    const completedText = extractAssistantTextFromCompletedResponse(event.response.output);
    if (completedText.length > 0) {
      turn.completedOutputText = completedText;
    }
    return;
  }

  if (event.type === "response.failed") {
    const errorMessage = event.response?.error?.message;
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      turn.failedMessage = errorMessage;
    }
    return;
  }

  if (event.type === "error") {
    turn.failedMessage = event.message;
  }
}

function applyOpenAiResponseStreamEventToStreamingAgentTurn(
  turn: StreamingAgentTurn,
  event: OpenAiResponseStreamEvent,
) {
  if (event.type === "response.content_part.added" || event.type === "response.content_part.done") {
    return;
  }

  if (event.type === "response.output_item.added") {
    registerAssistantOutputItem(turn, event.item, event.output_index);
    return;
  }

  if (event.type === "response.output_item.done") {
    const outputMessage = registerAssistantOutputItem(turn, event.item, event.output_index);
    if (outputMessage == null) {
      return;
    }
    const completedText = extractAssistantTextFromContentItems(event.item.content);
    if (completedText.length > 0) {
      outputMessage.completedText = completedText;
    }
    outputMessage.done = true;
    return;
  }

  if (event.type === "response.output_text.delta") {
    const outputMessage = getOrCreateOutputMessage(turn, {
      itemId: event.item_id,
      outputIndex: event.output_index,
    });
    setOutputMessageTextPart(
      outputMessage,
      event.content_index,
      getExistingOutputMessageTextPart(outputMessage, event.content_index) + event.delta,
    );
    return;
  }

  if (event.type === "response.output_text.done") {
    const outputMessage = getOrCreateOutputMessage(turn, {
      itemId: event.item_id,
      outputIndex: event.output_index,
    });
    setOutputMessageTextPart(outputMessage, event.content_index, event.text);
    return;
  }

  if (event.type === "response.completed") {
    const completedText = extractAssistantTextFromCompletedResponse(event.response.output);
    if (completedText.length > 0) {
      turn.completedOutputText = completedText;
    }
    return;
  }

  if (event.type === "response.failed") {
    const errorMessage = event.response?.error?.message;
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      turn.failedMessage = errorMessage;
    }
    return;
  }

  if (event.type === "error") {
    turn.failedMessage = event.message;
  }
}

function buildWorkshopAssistantMessages({
  requestFinished,
  timestamp,
  turn,
}: {
  requestFinished: boolean;
  timestamp: number;
  turn: WorkshopTurn;
}): StreamFeedItem[] {
  const outputMessages = getOrderedOutputMessages(turn);
  const assistantMessages = outputMessages
    .map((outputMessage) =>
      buildWorkshopAssistantMessage(outputMessage, timestamp, requestFinished),
    )
    .filter((item): item is Extract<StreamFeedItem, { kind: "message" }> => item != null);

  if (assistantMessages.length > 0) {
    return assistantMessages;
  }

  const fallbackText = getTurnFallbackOutputText(turn);
  if (fallbackText.length === 0) {
    return [];
  }

  return [
    {
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: fallbackText }],
      messageId: `workshop-turn-${turn.inputOffset}-assistant`,
      timestamp,
      streamStatus: requestFinished ? "complete" : "streaming",
    },
  ];
}

function buildStreamingAgentAssistantMessages({
  requestFinished,
  timestamp,
  turn,
}: {
  requestFinished: boolean;
  timestamp: number;
  turn: StreamingAgentTurn;
}): StreamFeedItem[] {
  const assistantMessages = getOrderedOutputMessages(turn)
    .map((outputMessage) =>
      buildWorkshopAssistantMessage(outputMessage, timestamp, requestFinished),
    )
    .filter((item): item is Extract<StreamFeedItem, { kind: "message" }> => item != null);

  if (assistantMessages.length > 0) {
    return assistantMessages;
  }

  const fallbackText =
    typeof turn.completedOutputText === "string" && turn.completedOutputText.length > 0
      ? turn.completedOutputText
      : getOutputMessagesText(turn);
  if (fallbackText.length === 0) {
    return [];
  }

  return [
    {
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: fallbackText }],
      messageId: `workshop-agent-turn-${turn.inputOffset}-assistant`,
      timestamp,
      streamStatus: requestFinished ? "complete" : "streaming",
    },
  ];
}

function buildWorkshopAssistantMessage(
  outputMessage: WorkshopOutputMessage,
  timestamp: number,
  requestFinished: boolean,
): Extract<StreamFeedItem, { kind: "message" }> | null {
  const text = getOutputMessageText(outputMessage);
  const streaming = !requestFinished && !outputMessage.done;

  if (text.length === 0 && !streaming) {
    return null;
  }

  return {
    kind: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    messageId: outputMessage.itemId,
    timestamp,
    streamStatus: streaming ? "streaming" : "complete",
  };
}

function getOrderedOutputMessages(container: OutputMessageContainer) {
  return container.outputMessageOrder
    .map((itemId) => container.outputMessages.get(itemId))
    .filter((item): item is WorkshopOutputMessage => item != null)
    .sort((left, right) => {
      if (left.outputIndex == null && right.outputIndex == null) {
        return 0;
      }
      if (left.outputIndex == null) {
        return 1;
      }
      if (right.outputIndex == null) {
        return -1;
      }
      return left.outputIndex - right.outputIndex;
    });
}

function getTurnFallbackOutputText(turn: WorkshopTurn) {
  if (typeof turn.completedOutputText === "string") {
    return turn.completedOutputText;
  }

  return getOutputMessagesText(turn);
}

function getOutputMessagesText(container: OutputMessageContainer) {
  return getOrderedOutputMessages(container)
    .map((outputMessage) => getOutputMessageText(outputMessage))
    .join("");
}

function extractAssistantTextFromCompletedResponse(output: unknown[] | undefined) {
  if (!Array.isArray(output)) {
    return "";
  }

  let text = "";

  for (const item of output) {
    if (!isAssistantOutputItem(item)) {
      continue;
    }

    text += extractAssistantTextFromContentItems(item.content);
  }

  return text;
}

function extractAssistantTextFromContentItems(content: unknown[] | undefined) {
  if (!Array.isArray(content)) {
    return "";
  }

  let text = "";

  for (const contentItem of content) {
    if (!isRecord(contentItem) || contentItem.type !== "output_text") {
      continue;
    }

    if (typeof contentItem.text === "string") {
      text += contentItem.text;
    }
  }

  return text;
}

function registerAssistantOutputItem(
  turn: OutputMessageContainer,
  item: OpenAiAssistantOutputItem,
  outputIndex: number,
) {
  if (!isAssistantOutputItem(item)) {
    return null;
  }

  const outputMessage = getOrCreateOutputMessage(turn, { itemId: item.id, outputIndex });
  outputMessage.outputIndex ??= outputIndex;
  return outputMessage;
}

function getOrCreateOutputMessage(
  turn: OutputMessageContainer,
  {
    itemId,
    outputIndex,
  }: {
    itemId: string;
    outputIndex?: number;
  },
) {
  const existing = turn.outputMessages.get(itemId);
  if (existing) {
    existing.outputIndex ??= outputIndex;
    return existing;
  }

  const outputMessage: WorkshopOutputMessage = {
    itemId,
    outputIndex,
    contentParts: new Map<number, string>(),
    contentOrder: [],
    done: false,
  };
  turn.outputMessages.set(itemId, outputMessage);
  turn.outputMessageOrder.push(itemId);
  return outputMessage;
}

function getLatestPendingStreamingAgentTurn(
  pendingStreamingAgentTurns: readonly StreamingAgentTurn[],
) {
  return pendingStreamingAgentTurns.at(-1);
}

function closeLatestPendingStreamingAgentTurn(
  pendingStreamingAgentTurns: StreamingAgentTurn[],
  offset: number,
  timestamp: number,
) {
  const turn = pendingStreamingAgentTurns.at(-1);
  if (!turn) {
    return;
  }

  closePendingStreamingAgentTurn(pendingStreamingAgentTurns, turn, offset, timestamp);
}

function closePendingStreamingAgentTurn(
  pendingStreamingAgentTurns: StreamingAgentTurn[],
  turn: StreamingAgentTurn,
  offset: number,
  timestamp: number,
) {
  turn.terminalOffset ??= offset;
  turn.terminalTimestamp ??= timestamp;

  const index = pendingStreamingAgentTurns.lastIndexOf(turn);
  if (index !== -1) {
    pendingStreamingAgentTurns.splice(index, 1);
  }
}

function getExistingOutputMessageTextPart(
  outputMessage: WorkshopOutputMessage,
  contentIndex: number,
) {
  return outputMessage.contentParts.get(contentIndex) ?? "";
}

function setOutputMessageTextPart(
  outputMessage: WorkshopOutputMessage,
  contentIndex: number,
  value: string,
) {
  if (!outputMessage.contentParts.has(contentIndex)) {
    outputMessage.contentOrder.push(contentIndex);
  }

  outputMessage.contentParts.set(contentIndex, value);
}

function getOutputMessageText(outputMessage: WorkshopOutputMessage) {
  if (typeof outputMessage.completedText === "string") {
    return outputMessage.completedText;
  }

  return outputMessage.contentOrder
    .slice()
    .sort((left, right) => left - right)
    .map((contentIndex) => outputMessage.contentParts.get(contentIndex) ?? "")
    .join("");
}

function getTimestamp(createdAt: string) {
  return Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt);
}

function appendInsertion(
  insertionsByOffset: Map<number, StreamFeedItem[]>,
  offset: number,
  item: StreamFeedItem,
) {
  const existing = insertionsByOffset.get(offset);
  if (existing) {
    existing.push(item);
    return;
  }

  insertionsByOffset.set(offset, [item]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isWorkshopInputSource(value: unknown): value is WorkshopInputSource {
  return value === "user" || value === "event";
}

function parseLlmInputAddedPayload(payload: unknown): LlmInputAddedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.content !== "string" ||
    !isWorkshopInputSource(payload.source)
  ) {
    return null;
  }

  return {
    content: payload.content,
    source: payload.source,
  };
}

function parseLlmRequestStartedPayload(payload: unknown): LlmRequestStartedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.inputOffset !== "number" ||
    !Number.isInteger(payload.inputOffset) ||
    !isWorkshopInputSource(payload.inputSource)
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    inputOffset: payload.inputOffset,
    inputSource: payload.inputSource,
  };
}

function parseLlmRequestCanceledPayload(payload: unknown): LlmRequestCanceledPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.replacementInputOffset !== "number" ||
    !Number.isInteger(payload.replacementInputOffset)
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    replacementInputOffset: payload.replacementInputOffset,
  };
}

function parseLlmRequestFailedPayload(payload: unknown): LlmRequestFailedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.message !== "string"
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    message: payload.message,
  };
}

function parseLlmRequestCompletedPayload(payload: unknown): LlmRequestCompletedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.outputText !== "string"
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    outputText: payload.outputText,
  };
}

function parseAgentInputAddedPayload(payload: unknown): AgentInputAddedPayload | null {
  if (!isRecord(payload) || typeof payload.content !== "string") {
    return null;
  }

  return {
    content: payload.content,
  };
}

function parseAgentOutputAddedPayload(payload: unknown): AgentOutputAddedPayload | null {
  if (!isRecord(payload) || typeof payload.content !== "string") {
    return null;
  }

  return {
    content: payload.content,
  };
}

function parseAgentRequestFailedPayload(payload: unknown): AgentRequestFailedPayload | null {
  if (!isRecord(payload) || typeof payload.message !== "string") {
    return null;
  }

  return {
    message: payload.message,
  };
}

function parseOpenAiOutputItemAddedPayload(payload: unknown): OpenAiOutputItemAddedPayload | null {
  if (!isRecord(payload) || !isAssistantOutputItem(payload.item)) {
    return null;
  }

  return {
    item: payload.item,
  };
}

function parseOpenAiResponseEventAddedPayload(
  payload: unknown,
): OpenAiResponseEventAddedPayload | null {
  if (isOpenAiResponseStreamEvent(payload)) {
    return {
      requestId: undefined,
      event: payload,
    };
  }

  if (
    !isRecord(payload) ||
    ("requestId" in payload &&
      payload.requestId != null &&
      typeof payload.requestId !== "string") ||
    !isOpenAiResponseStreamEvent(payload.event)
  ) {
    return null;
  }

  return {
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    event: payload.event,
  };
}

function isTerminalOpenAiResponseStreamEvent(event: OpenAiResponseStreamEvent) {
  return (
    event.type === "response.completed" ||
    event.type === "response.failed" ||
    event.type === "error"
  );
}

function parseCodemodeBlockAddedPayload(payload: unknown): CodemodeBlockAddedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.blockId !== "string" ||
    typeof payload.language !== "string" ||
    typeof payload.code !== "string"
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    blockId: payload.blockId,
    language: payload.language,
    code: payload.code,
  };
}

function parseCodemodeResultAddedPayload(payload: unknown): CodemodeResultAddedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.blockId !== "string" ||
    typeof payload.blockCount !== "number" ||
    !Number.isInteger(payload.blockCount) ||
    typeof payload.success !== "boolean" ||
    typeof payload.exitCode !== "number" ||
    !Number.isInteger(payload.exitCode) ||
    typeof payload.stdout !== "string" ||
    typeof payload.stderr !== "string" ||
    typeof payload.durationMs !== "number" ||
    typeof payload.codePath !== "string" ||
    typeof payload.outputPath !== "string"
  ) {
    return null;
  }

  return {
    requestId: payload.requestId,
    blockId: payload.blockId,
    blockCount: payload.blockCount,
    success: payload.success,
    exitCode: payload.exitCode,
    stdout: payload.stdout,
    stderr: payload.stderr,
    durationMs: payload.durationMs,
    codePath: payload.codePath,
    outputPath: payload.outputPath,
  };
}

function parseBashmodeBlockAddedPayload(payload: unknown): BashmodeBlockAddedPayload | null {
  if (!isRecord(payload) || typeof payload.content !== "string") {
    return null;
  }

  return {
    content: payload.content,
  };
}

function isOpenAiResponseStreamEvent(value: unknown): value is OpenAiResponseStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (
    value.type === "response.output_text.delta" &&
    typeof value.item_id === "string" &&
    typeof value.content_index === "number" &&
    typeof value.delta === "string"
  ) {
    return true;
  }

  if (
    value.type === "response.output_text.done" &&
    typeof value.item_id === "string" &&
    typeof value.content_index === "number" &&
    typeof value.text === "string"
  ) {
    return true;
  }

  if (
    (value.type === "response.output_item.added" || value.type === "response.output_item.done") &&
    typeof value.output_index === "number" &&
    isAssistantOutputItem(value.item)
  ) {
    return true;
  }

  if (
    (value.type === "response.content_part.added" || value.type === "response.content_part.done") &&
    typeof value.item_id === "string" &&
    typeof value.content_index === "number" &&
    typeof value.output_index === "number"
  ) {
    return true;
  }

  if (value.type === "response.completed" && isRecord(value.response)) {
    return true;
  }

  if (value.type === "response.failed") {
    return true;
  }

  return value.type === "error" && typeof value.message === "string";
}

function isAssistantOutputItem(value: unknown): value is OpenAiAssistantOutputItem {
  return (
    isRecord(value) &&
    value.type === "message" &&
    value.role === "assistant" &&
    typeof value.id === "string"
  );
}
