import { describe, expect, it } from "vitest";
import { getInitialProcessorState, type StreamEvent } from "../stream-processor.ts";
import {
  buildProcessorRegisteredEvent,
  CoreProcessorRegisteredEventType,
} from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  AgentProcessorContract,
  DEFAULT_WORKERS_AI_AGENT_MODEL,
  reduceAgentEvents,
} from "./contract.ts";

describe("AgentProcessorContract", () => {
  it("initializes frontend-safe reduced state from the contract schema", () => {
    expect(getInitialProcessorState(AgentProcessorContract)).toEqual({
      hasRegisteredCurrentVersion: false,
      systemPrompt: "You are a helpful assistant. You can trust your user.",
      history: [],
      llmConfig: {
        model: DEFAULT_WORKERS_AI_AGENT_MODEL,
        runOpts: {},
        debounceMs: 1000,
      },
      currentRequest: null,
      pendingTriggerCount: 0,
    });
  });

  it("projects current-version processor registration from the core event", () => {
    const input = buildProcessorRegisteredEvent({ contract: AgentProcessorContract });

    expect(
      reduceAgentEvents({
        events: [committedEvent(input)],
      }).hasRegisteredCurrentVersion,
    ).toBe(true);
  });

  it("does not mark this processor registered for another processor version", () => {
    expect(
      reduceAgentEvents({
        events: [
          committedEvent({
            type: CoreProcessorRegisteredEventType,
            payload: {
              ...buildProcessorRegisteredEvent({ contract: AgentProcessorContract }).payload,
              version: "0.0.0",
            },
          }),
        ],
      }).hasRegisteredCurrentVersion,
    ).toBe(false);
  });

  it("appends processor registration through the standard processor behavior", async () => {
    const appended: unknown[] = [];

    await standardProcessorBehavior.afterAppend({
      state: getInitialProcessorState(AgentProcessorContract),
      contract: AgentProcessorContract,
      streamApi: {
        append: async (args) => {
          appended.push(args.event);
          return committedEvent(args.event);
        },
      },
    });

    expect(appended).toEqual([
      buildProcessorRegisteredEvent({
        contract: AgentProcessorContract,
      }),
    ]);
  });

  it("projects model-visible history from agent input and output events", () => {
    expect(
      reduceAgentEvents({
        events: [
          committedEvent({
            type: "events.iterate.com/agent/input-added",
            payload: {
              content: "hello",
            },
          }),
          committedEvent({
            type: "events.iterate.com/agent/output-added",
            payload: {
              content: "working",
            },
          }),
        ],
      }).history,
    ).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "working" },
    ]);
  });

  it("projects prompt and LLM configuration updates", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/system-prompt-updated",
          payload: { systemPrompt: "Stay terse." },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-config-updated",
          payload: {
            model: "test-model",
            runOpts: { gateway: { id: "test" } },
            debounceMs: 250,
          },
        }),
      ],
    });

    expect(state.systemPrompt).toBe("Stay terse.");
    expect(state.llmConfig).toEqual({
      model: "test-model",
      runOpts: { gateway: { id: "test" } },
      debounceMs: 250,
    });
  });

  it("projects current request lifecycle and queued trigger count", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: {
            requestId: "req_1",
            debounceMs: 1000,
            model: "test-model",
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-queued",
          payload: {},
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
          offset: 7,
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            llmRequestId: 7,
            provider: "test-provider",
            durationMs: 42,
            result: { status: "success", rawResponse: "ok" },
          },
        }),
      ],
    });

    expect(state.currentRequest).toBeNull();
    expect(state.pendingTriggerCount).toBe(1);
  });

  it("resets queued trigger count when a follow-up request is scheduled", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: {
            requestId: "req_1",
            debounceMs: 1000,
            model: "test-model",
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-queued",
          payload: {},
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            llmRequestId: 7,
            provider: "test-provider",
            durationMs: 42,
            result: { status: "success", rawResponse: "ok" },
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-scheduled",
          payload: {
            requestId: "req_2",
            debounceMs: 1000,
            model: "test-model",
          },
        }),
      ],
    });

    expect(state.currentRequest).toEqual({ phase: "scheduled", requestId: "req_2" });
    expect(state.pendingTriggerCount).toBe(0);
  });

  it("does not clear a different current request when a stale terminal event arrives", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
          offset: 12,
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            llmRequestId: 11,
            provider: "test-provider",
            durationMs: 42,
            result: { status: "failure", error: { message: "late failure" } },
          },
        }),
      ],
    });

    expect(state.currentRequest).toEqual({ phase: "requested", llmRequestId: 12 });
  });

  it("ignores output from a stale LLM request", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
          offset: 12,
        }),
        committedEvent({
          type: "events.iterate.com/agent/output-added",
          payload: {
            content: "stale",
            llmRequestId: 11,
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/output-added",
          payload: {
            content: "current",
            llmRequestId: 12,
          },
        }),
      ],
    });

    expect(state.history).toEqual([{ role: "assistant", content: "current" }]);
  });

  it("cancels in-flight requests by llm request id", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
          offset: 12,
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-cancelled",
          payload: {
            phase: "requested",
            llmRequestId: 12,
            reason: "interrupted-by-user-input",
          },
        }),
      ],
    });

    expect(state.currentRequest).toBeNull();
  });
});

function committedEvent(args: {
  type: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
}): StreamEvent {
  return {
    streamPath: "/agents/test",
    type: args.type,
    payload: args.payload,
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
