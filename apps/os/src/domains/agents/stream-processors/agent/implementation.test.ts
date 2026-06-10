// Ported from packages/shared/src/stream-processors/agent/implementation.test.ts
// onto the class-based StreamProcessor model: events are driven through
// `ingest` and state is seeded through `readState` snapshots. Idempotency-key
// assertions are wire-format regression checks — they must not change.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialProcessorState } from "@iterate-com/streams/shared/stream-processors";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import type {
  StreamProcessorIterateContext,
  StreamProcessorSnapshot,
} from "@iterate-com/streams/stream-processor";
import { AgentProcessorContract, type AgentState } from "./contract.ts";
import { AgentProcessor } from "./implementation.ts";

describe("AgentProcessor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule LLM work for explicitly non-triggering agent input", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            content: "hello",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
          offset: 42,
        }),
      ],
      streamMaxOffset: 42,
    });

    expect(appended).toEqual([]);
  });

  it("schedules debounced LLM work by default", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            content: "hello",
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
          offset: 42,
        }),
      ],
      streamMaxOffset: 42,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: "agent/llm-request-scheduled@42",
        payload: expect.objectContaining({
          debounceMs: 1000,
          model: "@cf/moonshotai/kimi-k2.6",
        }),
      }),
    ]);
  });

  it("queues a follow-up for after-current-request while an LLM request is in flight", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 12,
        state: {
          ...initialState(),
          currentRequest: { phase: "requested", llmRequestId: 12 },
        },
      },
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            content: "follow up",
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
          offset: 43,
        }),
      ],
      streamMaxOffset: 43,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-queued",
        idempotencyKey: "agent/llm-request-queued@43",
        payload: {},
      }),
    ]);
  });

  it("cancels in-flight work and schedules a fresh request for interrupt-current-request", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 12,
        state: {
          ...initialState(),
          currentRequest: { phase: "requested", llmRequestId: 12 },
        },
      },
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            content: "stop and do this",
            llmRequestPolicy: { behaviour: "interrupt-current-request" },
          },
          offset: 44,
        }),
      ],
      streamMaxOffset: 44,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-cancelled",
        idempotencyKey: "agent/llm-request-cancelled/interrupted-by-user-input@44",
        payload: {
          phase: "requested",
          llmRequestId: 12,
          reason: "interrupted-by-user-input",
        },
      }),
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: "agent/llm-request-scheduled@44",
      }),
    ]);
  });

  it("marks requested LLM work as a working status update", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
          offset: 43,
        }),
      ],
      streamMaxOffset: 43,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/status-updated",
        idempotencyKey: "agent/status-updated/working/llm-request-requested@43",
        payload: {
          status: "working",
          reason: "llm-request-requested",
          llmRequestId: 43,
        },
      }),
    ]);
  });

  it("does not render completed LLM request events into model-visible history", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 43,
        state: {
          ...initialState(),
          currentRequest: { phase: "requested", llmRequestId: 43 },
        },
      },
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            llmRequestId: 43,
            provider: "openai-ws",
            durationMs: 6164,
            result: { status: "success" },
          },
          offset: 44,
        }),
      ],
      streamMaxOffset: 44,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/status-updated",
        idempotencyKey: "agent/status-updated/idle/llm-request-completed@44",
        payload: {
          status: "idle",
          reason: "llm-request-completed",
          llmRequestId: 43,
        },
      }),
    ]);
  });

  it("does not render queued LLM request events into model-visible history", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 44,
        state: {
          ...initialState(),
          currentRequest: { phase: "requested", llmRequestId: 43 },
        },
      },
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-queued",
          payload: {},
          offset: 45,
        }),
      ],
      streamMaxOffset: 45,
    });

    expect(appended).toEqual([]);
  });

  it("renders capability notes into model-visible instructions", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/capability-noted",
          payload: {
            instructions: "Use itx.chat.sendMessage({ message }) for chat output.",
            name: "chat",
          },
          offset: 44,
        }),
      ],
      streamMaxOffset: 44,
    });

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-agent-capability-noted@44",
      payload: {
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
    const payload = appended[1]?.payload as { content: string };
    expect(payload.content).toContain("itx.chat");
    expect(payload.content).toContain("itx.chat.sendMessage({ message })");
    expect(payload.content).toContain("offset 44");
  });

  it("recovers a scheduled request whose debounce timer died with a previous incarnation", async () => {
    const { stream, appended } = memoryStream();
    const scheduledEvent = agentEvent({
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: { requestId: "req_lost", debounceMs: 1000, model: "test-model" },
      offset: 7,
    });
    // The previous incarnation appended llm-request-scheduled and armed an
    // in-memory debounce timer, then died before the timer fired. This fresh
    // instance has the durable "scheduled" phase but no timer — the classic
    // wedge. The subscriber-connected presence fact alone must convert the
    // scheduled phase into a real llm-request-requested.
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 7,
        state: {
          ...initialState(),
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledAtOffset: 7 },
        },
      },
      readStreamEvents: async () => [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: { content: "hi", llmRequestPolicy: { behaviour: "after-current-request" } },
          offset: 6,
        }),
        scheduledEvent,
      ],
    });

    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 8 })],
      streamMaxOffset: 8,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-requested",
        // Derived from the original scheduled event, so the recovery path and
        // the (dead) timer path converge on the same idempotency key — if the
        // timer somehow fired before the crash landed its append, this dedups.
        idempotencyKey: "agent/llm-request-requested@7",
      }),
    ]);
  });

  it("does not re-request when the scheduled phase was already cancelled in history", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 7,
        state: {
          ...initialState(),
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledAtOffset: 7 },
        },
      },
      // Committed history says the schedule was already cancelled — the
      // snapshot is just behind. The recovery must trust history and do
      // nothing rather than fire a request the user interrupted.
      readStreamEvents: async () => [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: { requestId: "req_lost", debounceMs: 1000, model: "test-model" },
          offset: 7,
        }),
        agentEvent({
          type: "events.iterate.com/agent/llm-request-cancelled",
          payload: {
            phase: "scheduled",
            requestId: "req_lost",
            reason: "interrupted-by-user-input",
          },
          offset: 8,
        }),
      ],
    });

    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 9 })],
      streamMaxOffset: 9,
    });

    expect(appended).toEqual([]);
  });

  it("re-arms the debounce from durable state when input arrives after a restart", async () => {
    vi.useFakeTimers();
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 7,
        state: {
          ...initialState(),
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledAtOffset: 7 },
        },
      },
      readStreamEvents: async () => [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: { requestId: "req_lost", debounceMs: 1000, model: "test-model" },
          offset: 7,
        }),
      ],
    });

    // Default-policy input during a timerless scheduled phase used to bail
    // silently (the warm scheduledEvent was gone), wedging the agent forever.
    // The durable scheduledAtOffset lets the reset path re-arm instead.
    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: { content: "hello?", llmRequestPolicy: { behaviour: "after-current-request" } },
          offset: 8,
        }),
      ],
      streamMaxOffset: 8,
    });
    expect(appended).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: "agent/llm-request-requested@7",
      }),
    ]);
  });

  it("re-reads stream history before handing a scheduled LLM request to providers", async () => {
    vi.useFakeTimers();
    const { stream, appended } = memoryStream();
    const triggeringInput = agentEvent({
      type: "events.iterate.com/agent/input-added",
      payload: { content: "hi", llmRequestPolicy: { behaviour: "after-current-request" } },
      offset: 3,
    });
    const processor = newAgentProcessor({
      stream,
      // Committed history at the time the debounce fires: the primer row that
      // reached the stream after the trigger, plus the scheduled event this
      // processor appended (the request handoff re-verifies the schedule is
      // still current against history).
      readStreamEvents: async () => [
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            content: "codemode primer",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
          offset: 2,
        }),
        triggeringInput,
        ...appended
          .filter((event) => event.type === "events.iterate.com/agent/llm-request-scheduled")
          .map((event, index) =>
            agentEvent({ type: event.type, payload: event.payload, offset: 4 + index }),
          ),
      ],
    });

    await processor.ingest({ events: [triggeringInput], streamMaxOffset: 3 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: {
        body: {
          messages: [
            { role: "system", content: "You are a helpful assistant. You can trust your user." },
            { role: "user", content: "codemode primer" },
            { role: "user", content: "hi" },
          ],
        },
      },
    });
  });
});

function initialState(): AgentState {
  return getInitialProcessorState(AgentProcessorContract);
}

function newAgentProcessor(args: {
  stream: StreamProcessorIterateContext["stream"];
  snapshot?: StreamProcessorSnapshot<AgentState>;
  readStreamEvents?: () => Promise<StreamEvent[]>;
}) {
  return new AgentProcessor({
    iterateContext: { stream: args.stream },
    readState: () => args.snapshot,
    readStreamEvents: args.readStreamEvents ?? (async () => []),
  });
}

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

function subscriberConnectedEvent(args: { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/stream/subscriber-connected",
    payload: {
      subscriptionKey: "agent-host:agent",
      direction: "outbound" as const,
      subscriber: { incarnationId: "fresh-incarnation" },
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function agentEvent(args: {
  type: string;
  payload: unknown;
  offset: number;
  idempotencyKey?: string;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
  };
}
