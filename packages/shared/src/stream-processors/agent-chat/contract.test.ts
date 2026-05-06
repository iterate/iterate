import { describe, expect, it } from "vitest";
import { getInitialProcessorState, type StreamEvent } from "../stream-processor.ts";
import { buildProcessorRegisteredEvent } from "../core/contract.ts";
import { AgentChatProcessorContract, reduceAgentChatEvents } from "./contract.ts";

describe("AgentChatProcessorContract", () => {
  it("initializes its own reduced state", () => {
    expect(getInitialProcessorState(AgentChatProcessorContract)).toEqual({
      hasRegisteredCurrentVersion: false,
    });
  });

  it("projects current-version processor registration from the core event", () => {
    expect(
      reduceAgentChatEvents({
        events: [
          committedEvent(buildProcessorRegisteredEvent({ contract: AgentChatProcessorContract })),
        ],
      }).hasRegisteredCurrentVersion,
    ).toBe(true);
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
