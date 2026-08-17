import { describe, expect, it } from "vitest";
import { StreamEvent, StreamEventInput } from "./schemas.ts";

describe("StreamEventInput", () => {
  it("rejects an idempotency key on an ephemeral event", () => {
    const input = {
      type: "events.iterate.test/streaming-chunk",
      payload: { text: "hello" },
      ephemeral: true,
      idempotencyKey: "streaming-chunk-1",
    };

    expect(() => StreamEventInput.parse(input)).toThrow(
      "ephemeral events cannot have an idempotencyKey",
    );
    expect(() =>
      StreamEvent.parse({
        ...input,
        offset: 1,
        createdAt: "2026-08-04T12:00:00.000Z",
        path: "/tests/schemas",
      }),
    ).toThrow("ephemeral events cannot have an idempotencyKey");
  });
});
