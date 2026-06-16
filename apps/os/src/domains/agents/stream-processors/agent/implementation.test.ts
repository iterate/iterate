// Events are driven through `ingest` and state is seeded through `readState`
// snapshots. Idempotency-key assertions are wire-format regression checks —
// they must not change.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialProcessorState } from "@iterate-com/shared/streams/stream-processors";
import type { StreamEvent, StreamEventInput } from "@iterate-com/shared/streams/stream-event";
import { AgentProcessorContract, type AgentState } from "./contract.ts";
import { AgentProcessor } from "./implementation.ts";
import type {
  StreamProcessorIterateContext,
  StreamProcessorSnapshot,
} from "~/domains/streams/engine/stream-processor.ts";

describe("AgentProcessor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders chat user messages into agent input", async () => {
    const { stream, appended } = memoryStream();
    const setupAgentRuntime = vi.fn(async () => undefined);
    const processor = newAgentProcessor({ stream, setupAgentRuntime });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agents/user-message-received",
          payload: { content: "hello", origin: "web" },
          offset: 5,
        }),
      ],
      streamMaxOffset: 5,
    });

    expect(setupAgentRuntime).toHaveBeenCalledOnce();
    expect(appended[0]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/event-type-explainer/events.iterate.com/agents/user-message-received",
    });
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-chat-message@5",
      payload: {
        content: [
          "```yaml",
          "event:",
          "  offset: 5",
          "  type: events.iterate.com/agents/user-message-received",
          "  origin: web",
          "  content: |-",
          "    hello",
          "```",
        ].join("\n"),
      },
    });
  });

  it("renders chat tool responses without triggering a request", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agents/web-message-sent",
          payload: { message: "sent" },
          offset: 9,
        }),
      ],
      streamMaxOffset: 9,
    });

    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-chat-response@9",
      payload: {
        content: [
          "```yaml",
          "event:",
          "  offset: 9",
          "  type: events.iterate.com/agents/web-message-sent",
          "  message: |-",
          "    sent",
          "```",
        ].join("\n"),
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
  });

  it("applies agent config facts by setting up runtime and appending concrete prompt facts", async () => {
    const { stream, appended } = memoryStream();
    const setupAgentRuntime = vi.fn(async () => undefined);
    const processor = newAgentProcessor({
      stream,
      setupAgentRuntime,
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/config-updated",
          payload: { systemPrompt: "Use the project tools." },
          offset: 12,
        }),
      ],
      streamMaxOffset: 12,
    });

    expect(setupAgentRuntime).toHaveBeenCalledOnce();
    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/system-prompt-updated",
        idempotencyKey: "agent/apply-config/system-prompt@12",
        payload: { systemPrompt: "Use the project tools." },
      }),
    ]);
  });

  it("does not render received chat messages on the agents root stream", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      isAgentsRootStream: () => true,
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agents/user-message-received",
          payload: { content: "hello root", origin: "web" },
          offset: 13,
        }),
      ],
      streamMaxOffset: 13,
    });

    expect(appended).toEqual([]);
  });

  it("does not render sent chat messages on the agents root stream", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      isAgentsRootStream: () => true,
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agents/web-message-sent",
          payload: { message: "sent from root" },
          offset: 14,
        }),
      ],
      streamMaxOffset: 14,
    });

    expect(appended).toEqual([]);
  });

  it("does not enqueue agent output scripts on the agents root stream", async () => {
    const { stream, appended } = memoryStream();
    const setupAgentRuntime = vi.fn(async () => undefined);
    const processor = newAgentProcessor({
      stream,
      isAgentsRootStream: () => true,
      setupAgentRuntime,
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/agent/output-added",
          payload: {
            content: [
              "async (itx) => {",
              "  await itx.chat.sendMessage({ message: 'hello' });",
              "}",
            ].join("\n"),
          },
          offset: 13,
        }),
      ],
      streamMaxOffset: 13,
    });

    expect(setupAgentRuntime).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("does not render script completions on the agents root stream", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      isAgentsRootStream: () => true,
    });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/itx/script-execution-completed",
          payload: { executionId: "root-script", ok: true, result: "done" },
          offset: 14,
        }),
      ],
      streamMaxOffset: 14,
    });

    expect(appended).toEqual([]);
  });

  it("ignores script completion events without a usable execution id", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/itx/script-execution-completed",
          payload: { executionId: "", ok: true, result: "done" },
          offset: 13,
        }),
      ],
      streamMaxOffset: 13,
    });

    expect(appended).toEqual([]);
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
        providerSelectedEvent({ offset: 41 }),
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
          model: "@cf/moonshotai/kimi-k2.7-code",
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
          llmProvider: "openai-ws",
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
          llmProvider: "openai-ws",
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

  it("renders provided capabilities into model-visible instructions", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        agentEvent({
          type: "events.iterate.com/itx/capability-provided",
          payload: {
            path: ["chat"],
            meta: { instructions: "Use itx.chat.sendMessage({ message }) for chat output." },
          },
          offset: 44,
        }),
      ],
      streamMaxOffset: 44,
    });

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-itx-capability-provided@44",
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
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledOffset: 7 },
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

  it("recovers a triggering input whose schedule append was not reduced before restart", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 42,
        state: {
          ...initialState(),
          history: [{ role: "user", content: "hi" }],
          llmProvider: "openai-ws",
          pendingTriggerOffset: 42,
        },
      },
    });

    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 43 })],
      streamMaxOffset: 43,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: "agent/llm-request-scheduled@42",
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
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledOffset: 7 },
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

  it("leaves live triggers to the input-added handler instead of double-scheduling on subscriber-connected", async () => {
    const { stream, appended } = memoryStream();
    const processor = newAgentProcessor({ stream });

    await processor.ingest({
      events: [
        providerSelectedEvent({ offset: 41 }),
        agentEvent({
          type: "events.iterate.com/agent/input-added",
          payload: { content: "hello" },
          offset: 42,
        }),
        subscriberConnectedEvent({ offset: 43 }),
      ],
      streamMaxOffset: 43,
    });

    expect(
      appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-scheduled"),
    ).toHaveLength(1);
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
          llmProvider: "openai-ws",
          currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledOffset: 7 },
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
    // The durable scheduledOffset lets the reset path re-arm instead.
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

  it("does not re-request on connect when the live instance already owns the schedule", async () => {
    vi.useFakeTimers();
    const { stream, appended } = memoryStream();
    const selectedProvider = providerSelectedEvent({ offset: 1 });
    const triggeringInput = agentEvent({
      type: "events.iterate.com/agent/input-added",
      payload: { content: "hi", llmRequestPolicy: { behaviour: "after-current-request" } },
      offset: 3,
    });
    const processor = newAgentProcessor({
      stream,
      readStreamEvents: async () => [
        selectedProvider,
        triggeringInput,
        ...appended
          .filter((event) => event.type === "events.iterate.com/agent/llm-request-scheduled")
          .map((event, index) =>
            agentEvent({ type: event.type, payload: event.payload, offset: 4 + index }),
          ),
      ],
    });

    // Live path: the input schedules the request and arms the in-instance
    // timer. A subscriber-connected fact arriving afterwards (any other
    // processor or a browser attaching) must not fire the request early or
    // double-request — the live timer owns the schedule.
    await processor.ingest({ events: [selectedProvider, triggeringInput], streamMaxOffset: 3 });
    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 5 })],
      streamMaxOffset: 5,
    });
    await vi.advanceTimersByTimeAsync(5000);

    const requested = appended.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-requested",
    );
    expect(requested).toHaveLength(1);
  });

  it("retries the handoff append instead of dropping the turn when it fails", async () => {
    vi.useFakeTimers();
    const { stream, appended } = memoryStream();
    const originalAppend = stream.append.bind(stream);
    let failNextRequestAppend = true;
    stream.append = (args: Parameters<typeof stream.append>[0]) => {
      const event = args.event as { type: string };
      if (
        failNextRequestAppend &&
        event.type === "events.iterate.com/agent/llm-request-requested"
      ) {
        failNextRequestAppend = false;
        throw new Error("transient append failure");
      }
      return originalAppend(args);
    };
    const processor = newAgentProcessor({
      stream,
      snapshot: {
        offset: 7,
        state: {
          ...initialState(),
          currentRequest: { phase: "scheduled", requestId: "req_retry", scheduledOffset: 7 },
        },
      },
      readStreamEvents: async () => [
        agentEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: { requestId: "req_retry", debounceMs: 1000, model: "test-model" },
          offset: 7,
        }),
      ],
    });

    // The connected-driven recovery's first handoff append fails; the durable
    // state still says "scheduled", so the turn must re-arm and retry rather
    // than silently dropping.
    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 8 })],
      streamMaxOffset: 8,
    });
    expect(
      appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-requested"),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: "agent/llm-request-requested@7",
      }),
    ]);
  });

  it("hands a scheduled LLM request to providers by reference, without a body", async () => {
    vi.useFakeTimers();
    const { stream, appended } = memoryStream();
    const selectedProvider = providerSelectedEvent({ offset: 1 });
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
        selectedProvider,
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

    await processor.ingest({ events: [selectedProvider, triggeringInput], streamMaxOffset: 3 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(appended).toHaveLength(2);
    // Request-by-reference: the handoff records which model to run,
    // but never embeds the conversation — providers rebuild it from history
    // up to this event's own offset (see llm-request-helpers.ts).
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: expect.any(String) },
    });
    expect(appended[1]!.payload).not.toHaveProperty("body");
  });
});

function initialState(): AgentState {
  return getInitialProcessorState(AgentProcessorContract);
}

function newAgentProcessor(args: {
  stream: StreamProcessorIterateContext["stream"];
  isAgentsRootStream?: () => boolean;
  snapshot?: StreamProcessorSnapshot<AgentState>;
  readStreamEvents?: () => Promise<StreamEvent[]>;
  setupAgentRuntime?: () => Promise<unknown>;
}) {
  return new AgentProcessor({
    iterateContext: { stream: args.stream },
    isAgentsRootStream: args.isAgentsRootStream ?? (() => false),
    readState: () => args.snapshot,
    readStreamEvents: args.readStreamEvents ?? (async () => []),
    setupAgentRuntime: args.setupAgentRuntime ?? (async () => undefined),
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
      subscriptionKey: "agent:agent",
      direction: "outbound" as const,
      subscriber: { incarnationId: "fresh-incarnation" },
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function providerSelectedEvent(args: { offset: number }): StreamEvent {
  return agentEvent({
    type: "events.iterate.com/agent/llm-provider-selected",
    payload: {
      model: "@cf/moonshotai/kimi-k2.7-code",
      provider: "openai-ws",
    },
    offset: args.offset,
  });
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
