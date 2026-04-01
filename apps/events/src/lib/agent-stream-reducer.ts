/**
 * Protocol-aware semantic reduction for TanStack AI agent events on the events stream.
 * Maps `input-item-added` / `output-item-added` into semantic feed items keyed by event offset.
 */
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import type { Event } from "@iterate-com/events-contract";
import type { StreamFeedItem } from "~/lib/stream-feed-types.ts";

const INPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/input-item-added" as const;
const OUTPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/output-item-added" as const;

type TextModelMessage = ModelMessage<string>;
type AgentMessageRole = Extract<TextModelMessage["role"], "user" | "assistant">;
type AgentInputMessage = Omit<TextModelMessage, "role"> & { role: AgentMessageRole };

type InputItemAddedPayload = {
  item: AgentInputMessage;
};

type RunErrorChunk = {
  type: "RUN_ERROR";
  error: string;
};

type OutputItemAddedPayload = {
  chunk: StreamChunk | RunErrorChunk;
};

type AgentTurn = {
  inputOffset: string;
  inputRole: AgentMessageRole;
  inputText: string;
  inputTimestamp: number;
  outputChunks: StreamChunk[];
  latestOutputOffset?: string;
  hasFinalAssistantMessage?: boolean;
  outputError?: {
    title: string;
    message: string;
    raw: unknown;
  };
  outputTimestamp?: number;
};

function getTimestamp(createdAt: string) {
  return Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt);
}

function appendInsertion(
  insertionsByOffset: Map<string, StreamFeedItem[]>,
  offset: string,
  item: StreamFeedItem,
) {
  const existing = insertionsByOffset.get(offset);
  if (existing) {
    existing.push(item);
    return;
  }

  insertionsByOffset.set(offset, [item]);
}

/**
 * Builds semantic insertions for agent input/output events only.
 * Merge with lifecycle semantics from `toSemanticFeedItem` in the projection layer.
 */
export function buildAgentSemanticInsertions(
  events: readonly Event[],
): Map<string, StreamFeedItem[]> {
  const insertionsByOffset = new Map<string, StreamFeedItem[]>();
  const pendingTurns: AgentTurn[] = [];
  const turns: AgentTurn[] = [];

  for (const event of events) {
    if (event.type === INPUT_ITEM_ADDED_TYPE) {
      const payload = parseInputItemAddedPayload(event.payload);
      if (!payload) {
        continue;
      }

      appendInsertion(insertionsByOffset, event.offset, {
        kind: "message",
        role: payload.item.role,
        content: [{ type: "text", text: payload.item.content }],
        timestamp: getTimestamp(event.createdAt),
      });

      if (payload.item.role !== "user") {
        const turn = pendingTurns.find((candidate) => candidate.hasFinalAssistantMessage !== true);
        if (turn) {
          turn.hasFinalAssistantMessage = true;
        }
        continue;
      }

      const turn: AgentTurn = {
        inputOffset: event.offset,
        inputRole: payload.item.role,
        inputText: payload.item.content,
        inputTimestamp: getTimestamp(event.createdAt),
        outputChunks: [],
      };

      turns.push(turn);
      pendingTurns.push(turn);
      continue;
    }

    if (event.type !== OUTPUT_ITEM_ADDED_TYPE) {
      continue;
    }

    const payload = parseOutputItemAddedPayload(event.payload);
    if (!payload) {
      continue;
    }

    const turn = pendingTurns.find((candidate) => candidate.hasFinalAssistantMessage !== true);
    if (!turn) {
      continue;
    }

    turn.latestOutputOffset = event.offset;
    turn.outputTimestamp ??= getTimestamp(event.createdAt);

    if (isRunErrorChunk(payload.chunk)) {
      turn.outputError = {
        title: "Agent run failed",
        message: payload.chunk.error,
        raw: {
          inputOffset: turn.inputOffset,
          error: payload.chunk.error,
        },
      };
      continue;
    }

    if (payload.chunk.type === "error") {
      turn.outputError = {
        title: "Agent response ended with error",
        message: payload.chunk.error.message,
        raw: {
          inputOffset: turn.inputOffset,
          error: payload.chunk.error,
        },
      };
      continue;
    }

    turn.outputChunks.push(payload.chunk);
  }

  for (const turn of turns) {
    if (turn.outputTimestamp == null && turn.outputError == null) {
      continue;
    }

    const insertionOffset = turn.latestOutputOffset ?? turn.inputOffset;
    for (const item of buildAgentOutputFeedItems(turn)) {
      appendInsertion(insertionsByOffset, insertionOffset, item);
    }
  }

  return insertionsByOffset;
}

function turnStreamComplete(turn: AgentTurn): boolean {
  if (turn.outputError != null) {
    return true;
  }
  return turn.outputChunks.some((c) => c.type === "done");
}

function buildAgentOutputFeedItems(turn: AgentTurn): StreamFeedItem[] {
  const items: StreamFeedItem[] = [];
  const timestamp = turn.outputTimestamp ?? turn.inputTimestamp;
  const assistantText = extractAssistantText(turn.outputChunks);
  const complete = turnStreamComplete(turn);
  const hasAssistantContentChunk = turn.outputChunks.some((c) => c.type === "content");
  const showAssistantRow = assistantText.length > 0 || (!complete && hasAssistantContentChunk);

  if (!turn.hasFinalAssistantMessage && showAssistantRow) {
    items.push({
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      timestamp,
      streamStatus: complete ? "complete" : "streaming",
    });
  }

  for (const toolItem of buildToolFeedItemsFromChunks(turn.outputChunks, timestamp)) {
    items.push(toolItem);
  }

  if (turn.outputError) {
    items.push({
      kind: "error",
      message: turn.outputError.title,
      context: turn.outputError.message,
      timestamp,
      raw: turn.outputError.raw,
    });
  }

  return items;
}

function buildToolFeedItemsFromChunks(
  chunks: readonly StreamChunk[],
  timestamp: number,
): StreamFeedItem[] {
  const items: StreamFeedItem[] = [];
  const toolCalls = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      arguments: string;
      state: "pending" | "running" | "completed" | "error";
      output?: unknown;
      errorText?: string;
    }
  >();

  for (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      const id = chunk.toolCall.id;
      const name = chunk.toolCall.function.name;
      const args = chunk.toolCall.function.arguments ?? "";
      const existing = toolCalls.get(id);
      if (existing) {
        existing.arguments = args;
        existing.state = args ? "running" : "pending";
      } else {
        toolCalls.set(id, {
          toolCallId: id,
          toolName: name,
          arguments: args,
          state: args ? "running" : "pending",
        });
      }
    }

    if (chunk.type === "tool-input-available") {
      const existing = toolCalls.get(chunk.toolCallId);
      if (existing) {
        existing.state = "running";
      } else {
        toolCalls.set(chunk.toolCallId, {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          arguments: JSON.stringify(chunk.input),
          state: "running",
        });
      }
    }

    if (chunk.type === "approval-requested") {
      const existing = toolCalls.get(chunk.toolCallId);
      if (existing) {
        existing.state = "pending";
      } else {
        toolCalls.set(chunk.toolCallId, {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          arguments: JSON.stringify(chunk.input),
          state: "pending",
        });
      }
    }

    if (chunk.type === "tool_result") {
      const id = chunk.toolCallId;
      const existing = toolCalls.get(id);
      if (existing) {
        existing.output = chunk.content;
        existing.state = "completed";
      } else {
        toolCalls.set(id, {
          toolCallId: id,
          toolName: "tool",
          arguments: "",
          state: "completed",
          output: chunk.content,
        });
      }
    }
  }

  for (const t of toolCalls.values()) {
    items.push({
      kind: "tool",
      toolCallId: t.toolCallId,
      toolName: t.toolName,
      state: t.state === "completed" ? "completed" : t.state === "running" ? "running" : "pending",
      input: { arguments: t.arguments },
      output: t.output,
      errorText: t.errorText,
      startTimestamp: timestamp,
      endTimestamp: t.state === "completed" ? timestamp : undefined,
    });
  }

  return items;
}

function extractAssistantText(chunks: readonly StreamChunk[]) {
  let text = "";

  for (const chunk of chunks) {
    if (chunk.type !== "content") {
      continue;
    }

    if (chunk.delta !== "") {
      text += chunk.delta;
      continue;
    }

    if (chunk.content.startsWith(text)) {
      text = chunk.content;
      continue;
    }

    text = chunk.content;
  }

  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isAgentMessageRole(value: unknown): value is AgentMessageRole {
  return value === "user" || value === "assistant";
}

function parseInputItemAddedPayload(payload: unknown): InputItemAddedPayload | null {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    return null;
  }

  const { role, content } = payload.item;
  if (!isAgentMessageRole(role) || typeof content !== "string" || content.length === 0) {
    return null;
  }

  return {
    item: {
      role,
      content,
    },
  };
}

function isStreamChunk(value: unknown): value is StreamChunk {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.type === "string" &&
    typeof value.id === "string" &&
    typeof value.model === "string" &&
    typeof value.timestamp === "number"
  );
}

function isRunErrorChunk(value: unknown): value is RunErrorChunk {
  return isRecord(value) && value.type === "RUN_ERROR" && typeof value.error === "string";
}

function parseOutputItemAddedPayload(payload: unknown): OutputItemAddedPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (!isStreamChunk(payload.chunk) && !isRunErrorChunk(payload.chunk)) {
    return null;
  }

  return {
    chunk: payload.chunk,
  };
}
