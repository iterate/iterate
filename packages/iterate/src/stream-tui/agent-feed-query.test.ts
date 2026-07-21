import { describe, expect, test, vi } from "vitest";
import type { StreamEvent } from "../itx-api.generated.ts";
import type { Itx } from "../sdk/itx/react.ts";
import { ensureAgentFeedReady, readAgentFeedHistory } from "./agent-feed-query.ts";

const event = (offset: number): StreamEvent => ({
  type: "test/event",
  path: "/agents/test",
  offset,
  createdAt: new Date(1_700_000_000_000 + offset).toISOString(),
});

describe("readAgentFeedHistory", () => {
  test("births only an unborn agent before opening its feed", async () => {
    const createFresh = vi.fn(async () => {});
    await ensureAgentFeedReady({
      create: createFresh,
      processor: { snapshot: async () => ({ state: { birthCertificate: null } }) },
    });
    expect(createFresh).toHaveBeenCalledOnce();

    const createExisting = vi.fn(async () => {});
    await ensureAgentFeedReady({
      create: createExisting,
      processor: { snapshot: async () => ({ state: { birthCertificate: {} } }) },
    });
    expect(createExisting).not.toHaveBeenCalled();
  });

  test("finishes initialization before reading history", async () => {
    const order: string[] = [];
    const agent = {
      stream: {
        getEvents: vi.fn(async () => {
          order.push("history");
          return [];
        }),
      },
      [Symbol.dispose]: vi.fn(),
    };
    const itx = { agents: { get: () => agent } } as unknown as Itx;

    await expect(
      readAgentFeedHistory(itx, "/agents/test", {
        initialize: async (initializedAgent) => {
          expect(initializedAgent).toBe(agent);
          order.push("initialize");
        },
      }),
    ).resolves.toEqual([]);

    expect(order).toEqual(["initialize", "history"]);
    expect(agent[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  test("pages to the durable tail and releases the agent capability", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const secondPage = [event(501), event(502)];
    const getEvents = vi.fn(async ({ afterOffset }: { afterOffset?: number }) =>
      afterOffset === 0 ? firstPage : secondPage,
    );
    const dispose = vi.fn();
    const itx = {
      agents: {
        get: () => ({ stream: { getEvents }, [Symbol.dispose]: dispose }),
      },
    } as unknown as Itx;

    await expect(readAgentFeedHistory(itx, "/agents/test")).resolves.toEqual([
      ...firstPage,
      ...secondPage,
    ]);
    expect(getEvents).toHaveBeenNthCalledWith(1, { afterOffset: 0, limit: 500 });
    expect(getEvents).toHaveBeenNthCalledWith(2, { afterOffset: 500, limit: 500 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("rejects a non-advancing full page instead of looping forever", async () => {
    const getEvents = vi.fn(async () => Array.from({ length: 500 }, () => event(0)));
    const dispose = vi.fn();
    const itx = {
      agents: {
        get: () => ({ stream: { getEvents }, [Symbol.dispose]: dispose }),
      },
    } as unknown as Itx;

    await expect(readAgentFeedHistory(itx, "/agents/test")).rejects.toThrow(
      /did not advance beyond offset 0/,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
