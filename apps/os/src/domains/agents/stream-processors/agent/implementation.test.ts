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

  // Regression tests for the 2026-06-10 prod incident: a deploy evicted the
  // agent's Durable Object between `llm-request-scheduled` committing and the
  // in-memory debounce timer firing. The rehydrated instance never re-armed
  // the timer, so the turn never fired — and default-policy follow-up inputs
  // only tried to reset the nonexistent timer, wedging the stream forever.
  describe("scheduled request recovery after rehydration", () => {
    it("re-arms the debounce timer from a rehydrated checkpoint on snapshot()", async () => {
      vi.useFakeTimers();
      const { stream, appended } = memoryStream();
      const scheduled = agentEvent({
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { requestId: "req_lost", debounceMs: 1000, model: "test-model" },
        offset: 7,
      });
      const triggeringInput = agentEvent({
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hello?", llmRequestPolicy: { behaviour: "after-current-request" } },
        offset: 6,
      });
      // Simulates the post-eviction shape: the checkpoint says a request is
      // scheduled, but this (fresh) instance has no timer for it.
      const processor = newAgentProcessor({
        stream,
        snapshot: {
          offset: 7,
          state: {
            ...initialState(),
            history: [{ role: "user", content: "hello?" }],
            currentRequest: { phase: "scheduled", requestId: "req_lost", scheduledOffset: 7 },
          },
        },
        readStreamEvents: async () => [triggeringInput, scheduled],
      });

      // The host calls snapshot() on every subscription (re-)handshake — even
      // when the stream has no new events to deliver.
      await processor.snapshot();
      await vi.advanceTimersByTimeAsync(1000);

      expect(appended).toEqual([
        expect.objectContaining({
          type: "events.iterate.com/agent/llm-request-requested",
          idempotencyKey: "agent/llm-request-requested@7",
        }),
      ]);
    });

    it("re-arms the timer when a batch replays the scheduled state", async () => {
      vi.useFakeTimers();
      const { stream, appended } = memoryStream();
      const scheduled = agentEvent({
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { requestId: "req_replayed", debounceMs: 1000, model: "test-model" },
        offset: 7,
      });
      const processor = newAgentProcessor({
        stream,
        readStreamEvents: async () => [scheduled],
      });

      // Replay path: the scheduled event arrives in a batch (e.g. after a
      // re-handshake replays from an older checkpoint). processEvent treats it
      // as a no-op; the batch-level recovery must still arm the timer.
      await processor.ingest({ events: [scheduled], streamMaxOffset: 7 });
      await vi.advanceTimersByTimeAsync(1000);

      expect(appended).toEqual([
        expect.objectContaining({
          type: "events.iterate.com/agent/llm-request-requested",
          idempotencyKey: "agent/llm-request-requested@7",
        }),
      ]);
    });

    it("recovers the scheduled offset from history for checkpoints written before scheduledOffset existed", async () => {
      vi.useFakeTimers();
      const { stream, appended } = memoryStream();
      const scheduled = agentEvent({
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { requestId: "req_old", debounceMs: 1000, model: "test-model" },
        offset: 9,
      });
      const processor = newAgentProcessor({
        stream,
        snapshot: {
          offset: 9,
          state: {
            ...initialState(),
            // Old checkpoint shape: no scheduledOffset.
            currentRequest: { phase: "scheduled", requestId: "req_old" },
          },
        },
        readStreamEvents: async () => [scheduled],
      });

      await processor.snapshot();
      await vi.advanceTimersByTimeAsync(1000);

      expect(appended).toEqual([
        expect.objectContaining({
          type: "events.iterate.com/agent/llm-request-requested",
          idempotencyKey: "agent/llm-request-requested@9",
        }),
      ]);
    });

    it("does not double-arm when the live instance already owns the scheduled request", async () => {
      vi.useFakeTimers();
      const { stream, appended } = memoryStream();
      const triggeringInput = agentEvent({
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hi", llmRequestPolicy: { behaviour: "after-current-request" } },
        offset: 3,
      });
      const processor = newAgentProcessor({
        stream,
        readStreamEvents: async () => [triggeringInput],
      });

      // Live path: the input schedules the request (memoryStream commits the
      // scheduled event at offset 100) and arms the timer in-instance.
      await processor.ingest({ events: [triggeringInput], streamMaxOffset: 3 });
      const scheduledInput = appended[0] as { payload: { requestId: string } };
      // The stream then delivers the committed scheduled event back; recovery
      // must recognize the live timer instead of re-arming.
      await processor.ingest({
        events: [
          agentEvent({
            type: "events.iterate.com/agent/llm-request-scheduled",
            payload: {
              requestId: scheduledInput.payload.requestId,
              debounceMs: 1000,
              model: "test-model",
            },
            offset: 100,
          }),
        ],
        streamMaxOffset: 100,
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
        if (
          (args.event as { type: string }).type ===
            "events.iterate.com/agent/llm-request-requested" &&
          failNextRequestAppend
        ) {
          failNextRequestAppend = false;
          throw new Error("Network connection lost.");
        }
        return originalAppend(args);
      };
      const triggeringInput = agentEvent({
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hi", llmRequestPolicy: { behaviour: "after-current-request" } },
        offset: 3,
      });
      const processor = newAgentProcessor({
        stream,
        readStreamEvents: async () => [triggeringInput],
      });

      await processor.ingest({ events: [triggeringInput], streamMaxOffset: 3 });
      await vi.advanceTimersByTimeAsync(1000); // debounce fires; append fails
      await vi.advanceTimersByTimeAsync(1000); // retry timer fires; append succeeds

      expect(appended).toContainEqual(
        expect.objectContaining({
          type: "events.iterate.com/agent/llm-request-requested",
        }),
      );
    });
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
