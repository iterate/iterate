import { describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { appendIdempotentBirthBatch } from "./idempotent-birth.ts";
import { STREAM_UNAVAILABLE_MESSAGE_PREFIX } from "./stream-unavailable.ts";

const birthEvent: StreamEventInput = {
  type: "test/created",
  idempotencyKey: "test/created:one",
  payload: {},
};
const unkeyedBirthEvent: StreamEventInput = { type: "test/created", payload: {} };
const ephemeralBirthEvent: StreamEventInput = {
  ...birthEvent,
  ephemeral: true,
};

const committedEvent: StreamEvent = {
  ...birthEvent,
  createdAt: "2026-07-17T00:00:00.000Z",
  offset: 1,
  path: "/test",
};

describe("appendIdempotentBirthBatch", () => {
  it("retries the same keyed batch after a Stream DO lifecycle reset", async () => {
    const append = vi
      .fn<(...events: StreamEventInput[]) => Promise<StreamEvent[]>>()
      .mockRejectedValueOnce(new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}code deployment reset`))
      .mockResolvedValueOnce([committedEvent]);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        appendIdempotentBirthBatch({
          events: [birthEvent],
          operation: "agent /agents/test create",
          stream: { append },
        }),
      ).resolves.toEqual([committedEvent]);

      expect(append).toHaveBeenCalledTimes(2);
      expect(append).toHaveBeenNthCalledWith(1, birthEvent);
      expect(append).toHaveBeenNthCalledWith(2, birthEvent);
      expect(consoleWarn).toHaveBeenCalledOnce();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("does not retry application failures", async () => {
    const applicationError = new Error("birth certificate conflicts with existing state");
    const append = vi.fn(async () => Promise.reject(applicationError));

    await expect(
      appendIdempotentBirthBatch({
        events: [birthEvent],
        operation: "agent /agents/test create",
        stream: { append },
      }),
    ).rejects.toBe(applicationError);
    expect(append).toHaveBeenCalledOnce();
  });

  it.each<[string, StreamEventInput, string]>([
    ["unkeyed", unkeyedBirthEvent, "must have idempotency keys"],
    ["ephemeral", ephemeralBirthEvent, "must be durable"],
  ])("rejects a %s birth event before append", (_case, event, message) => {
    const append = vi.fn(async () => [committedEvent]);

    expect(() =>
      appendIdempotentBirthBatch({
        events: [event],
        operation: "agent /agents/test create",
        stream: { append },
      }),
    ).toThrow(message);
    expect(append).not.toHaveBeenCalled();
  });
});
