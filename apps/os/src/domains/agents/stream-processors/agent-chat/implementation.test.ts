// Idempotency-key assertions are wire-format regression checks — they must
// not change.

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import type { StreamProcessorIterateContext } from "@iterate-com/streams/stream-processor";
import { AgentChatProcessor } from "./implementation.ts";

describe("AgentChatProcessor", () => {
  it("renders user chat messages into agent input rows", async () => {
    const { stream, appended } = memoryStream();
    const processor = new AgentChatProcessor({ iterateContext: { stream } });

    await processor.ingest({
      events: [
        chatEvent({
          type: "events.iterate.com/agent-chat/user-message-added",
          payload: { channel: "web", content: "What can you help me with?" },
          offset: 5,
        }),
      ],
      streamMaxOffset: 5,
    });

    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey:
        "agent-chat/event-type-explainer/events.iterate.com/agent-chat/user-message-added",
      payload: {
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent-chat/render-message@5",
    });
    const rendered = appended[1]?.payload as { content: string; llmRequestPolicy?: unknown };
    expect(rendered.content).toContain("What can you help me with?");
    expect(rendered.content).toContain("channel: web");
    // The rendered user message keeps the default (triggering) request policy.
    expect(rendered.llmRequestPolicy).toBeUndefined();
  });

  it("renders assistant responses as non-triggering agent input rows", async () => {
    const { stream, appended } = memoryStream();
    const processor = new AgentChatProcessor({ iterateContext: { stream } });

    await processor.ingest({
      events: [
        chatEvent({
          type: "events.iterate.com/agent-chat/assistant-response-added",
          payload: { channel: "web", message: "Happy to help." },
          offset: 9,
        }),
      ],
      streamMaxOffset: 9,
    });

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent-chat/render-response@9",
      payload: {
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
    const rendered = appended[1]?.payload as { content: string };
    expect(rendered.content).toContain("Happy to help.");
  });

  it("dedups re-delivered chat events through the checkpoint", async () => {
    const { stream, appended } = memoryStream();
    const processor = new AgentChatProcessor({ iterateContext: { stream } });
    const event = chatEvent({
      type: "events.iterate.com/agent-chat/user-message-added",
      payload: { channel: "web", content: "hello" },
      offset: 5,
    });

    await processor.ingest({ events: [event], streamMaxOffset: 5 });
    await processor.ingest({ events: [event], streamMaxOffset: 5 });

    expect(appended).toHaveLength(2);
  });
});

function memoryStream() {
  let nextOffset = 100;
  const appended: StreamEventInput[] = [];
  const stream: StreamProcessorIterateContext["stream"] = {
    append: (args) => {
      appended.push(args.event);
      const committed: StreamEvent = {
        ...args.event,
        offset: nextOffset++,
        createdAt: new Date(0).toISOString(),
      };
      return committed;
    },
    appendBatch: (args) =>
      args.events.map((input) => {
        appended.push(input);
        const committed: StreamEvent = {
          ...input,
          offset: nextOffset++,
          createdAt: new Date(0).toISOString(),
        };
        return committed;
      }),
  };
  return { stream, appended };
}

function chatEvent(args: { type: string; payload: unknown; offset: number }): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
