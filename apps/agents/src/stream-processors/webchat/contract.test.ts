import { describe, expect, it } from "vitest";
import { getInitialProcessorState, type StreamEvent } from "@iterate-com/shared/stream-processors";
import { buildProcessorRegisteredEvent } from "../core/contract.ts";
import { WebchatProcessorContract, reduceWebchatEvents } from "./contract.ts";

describe("WebchatProcessorContract", () => {
  it("initializes its own reduced state", () => {
    expect(getInitialProcessorState(WebchatProcessorContract)).toEqual({
      hasRegisteredCurrentVersion: false,
    });
  });

  it("projects current-version processor registration from the core event", () => {
    expect(
      reduceWebchatEvents({
        events: [
          committedEvent(buildProcessorRegisteredEvent({ contract: WebchatProcessorContract })),
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
