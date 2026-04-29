import { describe, expect, it } from "vitest";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import { getInitialProcessorState, type StreamEvent } from "@iterate-com/shared/stream-processors";
import { AgentProcessorContract } from "../agent/contract.ts";
import { buildProcessorRegisteredEvent } from "../core/contract.ts";
import {
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  CodemodeProcessorContract,
  reduceCodemodeEvents,
} from "./contract.ts";

describe("CodemodeProcessorContract", () => {
  it("initializes separate frontend-safe reduced state", () => {
    expect(getInitialProcessorState(CodemodeProcessorContract)).toEqual({
      hasRegisteredCurrentVersion: false,
      agentProcessor: getInitialProcessorState(AgentProcessorContract),
      hasAppendedCodemodePrompt: false,
      toolProviders: {},
    });
  });

  it("projects current-version processor registration from the core event", () => {
    expect(
      reduceCodemodeEvents({
        events: [
          committedEvent(buildProcessorRegisteredEvent({ contract: CodemodeProcessorContract })),
        ],
      }).hasRegisteredCurrentVersion,
    ).toBe(true);
  });

  it("marks the codemode primer appended only from the primer idempotency key", () => {
    const state = reduceCodemodeEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/agent/input-added",
          payload: {
            role: "user",
            content: "ordinary row",
          },
        }),
        committedEvent({
          type: "events.iterate.com/agent/input-added",
          idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
          payload: {
            role: "user",
            content: "codemode primer",
          },
        }),
      ],
    });

    expect(state.hasAppendedCodemodePrompt).toBe(true);
    expect(state.agentProcessor.history).toEqual([
      { role: "user", content: "ordinary row" },
      { role: "user", content: "codemode primer" },
    ]);
  });

  it("keeps Agent processor reduced state embedded in its own reduced state", () => {
    expect(
      reduceCodemodeEvents({
        events: [
          committedEvent({
            type: "events.iterate.com/agent/llm-request-queued",
            payload: {},
          }),
        ],
      }).agentProcessor.pendingTriggerCount,
    ).toBe(1);
  });

  it("upserts and removes tool providers", () => {
    const executeCallable = {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "service",
        bindingName: "TEST_TOOL",
      },
      rpcMethod: "execute",
    } satisfies Callable;
    const getTypesCallable = {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "service",
        bindingName: "TEST_TOOL",
      },
      rpcMethod: "getTypes",
    } satisfies Callable;
    const upserted = reduceCodemodeEvents({
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/tool-provider-config-updated",
          payload: {
            slug: "mcp",
            executeCallable,
            getTypesCallable,
          },
        }),
      ],
    });

    expect(upserted.toolProviders).toEqual({
      mcp: {
        executeCallable,
        getTypesCallable,
      },
    });

    const deleted = reduceCodemodeEvents({
      state: upserted,
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/tool-provider-config-updated",
          payload: {
            slug: "mcp",
            executeCallable: null,
          },
        }),
      ],
    });

    expect(deleted.toolProviders).toEqual({});
  });

  it("leaves execution events unchanged in reduced state", () => {
    const state = getInitialProcessorState(CodemodeProcessorContract);

    expect(
      reduceCodemodeEvents({
        state,
        events: [
          committedEvent({
            type: "events.iterate.com/codemode/block-added",
            payload: { script: "async () => 1" },
          }),
          committedEvent({
            type: "events.iterate.com/codemode/result-added",
            payload: { result: 1, durationMs: 10 },
          }),
        ],
      }),
    ).toEqual(state);
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
