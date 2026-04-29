import { describe, expect, it } from "vitest";
import { AgentProcessorContract, reduceAgentEvents } from "./contract.ts";
import {
  CoreProcessorRegisteredEventType,
  createProcessorRegisteredInput,
} from "../core/contract.ts";
import { wellBehavedProcessorDefaults } from "../core/well-behaved-processor-defaults.ts";
import { getInitialProcessorState, type StreamEvent } from "@iterate-com/shared/stream-processors";

describe("AgentProcessorContract", () => {
  it("initializes frontend-safe reduced state from the contract schema", () => {
    expect(getInitialProcessorState(AgentProcessorContract)).toEqual({
      hasRegisteredCurrentVersion: false,
      systemPrompt: "You are a helpful assistant. You can trust your user.",
      history: [],
      llmConfig: {
        model: "@cf/moonshotai/kimi-k2.5",
        runOpts: {},
        debounceMs: 1000,
      },
      currentRequest: null,
      pendingTriggerCount: 0,
    });
  });

  it("projects current-version processor registration from the core event", () => {
    const input = createProcessorRegisteredInput({ contract: AgentProcessorContract });

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
              ...createProcessorRegisteredInput({ contract: AgentProcessorContract }).payload,
              version: "0.0.0",
            },
          }),
        ],
      }).hasRegisteredCurrentVersion,
    ).toBe(false);
  });

  it("appends processor registration through the well-behaved processor defaults", async () => {
    const appended: unknown[] = [];

    await wellBehavedProcessorDefaults.afterAppend({
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
      createProcessorRegisteredInput({
        contract: AgentProcessorContract,
      }),
    ]);
  });

  it("projects model-visible history from agent input events", () => {
    expect(
      reduceAgentEvents({
        events: [
          committedEvent({
            type: "events.iterate.com/agent/input-added",
            payload: {
              role: "user",
              content: "hello",
            },
          }),
          committedEvent({
            type: "events.iterate.com/agent/input-added",
            payload: {
              role: "assistant",
              content: "working",
              triggerLlmRequest: { behaviour: "dont-trigger-request" },
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
          type: "events.iterate.com/agent/llm-request-started",
          payload: {
            requestId: "req_1",
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            requestId: "req_1",
            rawResponse: "ok",
            durationMs: 42,
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
            requestId: "req_1",
            rawResponse: "ok",
            durationMs: 42,
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

    expect(state.currentRequest).toEqual({ requestId: "req_2" });
    expect(state.pendingTriggerCount).toBe(0);
  });

  it("does not clear a different current request when a stale terminal event arrives", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/llm-request-started",
          payload: {
            requestId: "req_current",
            model: "test-model",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/llm-request-failed",
          payload: {
            requestId: "req_old",
            durationMs: 42,
            error: { message: "late failure" },
          },
        }),
      ],
    });

    expect(state.currentRequest).toEqual({ requestId: "req_current" });
  });

  it("ignores raw webchat events in the reduced state projection", () => {
    const state = reduceAgentEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/webchat-message-received",
          payload: { content: "hello" },
        }),
        committedEvent({
          type: "events.iterate.com/agent/webchat-response-added",
          payload: { message: "hi" },
        }),
      ],
    });

    expect(state).toEqual(getInitialProcessorState(AgentProcessorContract));
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
