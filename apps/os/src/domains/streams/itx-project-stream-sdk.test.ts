import { describe, expect, it, vi } from "vitest";
import { itxProjectStream, type StreamEvent } from "iterate/sdk";

describe("itxProjectStream", () => {
  it("detaches and disposes an appendIfStreamId result obtained through the project stub", async () => {
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 1,
      path: "/events",
      type: "events.iterate.com/test/sdk-rpc-result",
    } satisfies StreamEvent;
    const result = [{ ...event }];
    const disposeResult = vi.fn();
    const disposeProject = vi.fn();
    Object.defineProperty(result, Symbol.dispose, { value: disposeResult });
    const project = {
      streams: {
        get: () => ({
          appendIfStreamId: async () => result,
        }),
      },
      [Symbol.dispose]: disposeProject,
    };
    const stream = itxProjectStream(
      {
        ITERATE_WORKER_VERSION: "test",
        ITX: {
          fetch: vi.fn(),
          get: async () => project,
        },
      } as never,
      "/events",
    );

    const committed = await stream.appendIfStreamId({
      streamId: "760f1ba4-3429-47ce-bfa9-eb52214fb699",
      events: [event],
    });

    expect(committed).toEqual([event]);
    expect(committed).not.toBe(result);
    expect(Reflect.has(committed, Symbol.dispose)).toBe(false);
    expect(disposeResult).toHaveBeenCalledOnce();
    expect(disposeProject).toHaveBeenCalledOnce();
  });
});
