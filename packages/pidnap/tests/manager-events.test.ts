import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Manager, type ManagerConfig } from "../src/manager.ts";
import type { Logger } from "../src/logger.ts";
import { createMockLogger, longRunningProcess } from "./test-utils.ts";

type PostedEvent = {
  path: string;
  event: {
    type: string;
    payload: Record<string, unknown>;
    version?: string | number;
  };
};

function extractPostedEvents(fetchMock: ReturnType<typeof vi.fn>): PostedEvent[] {
  const results: PostedEvent[] = [];
  for (const call of fetchMock.mock.calls) {
    const body = call[1]?.body;
    if (typeof body !== "string") continue;
    const parsed = JSON.parse(body) as {
      json?: {
        path: string;
        events?: Array<{
          type: string;
          payload: Record<string, unknown>;
          version?: string | number;
        }>;
      };
    };
    const event = parsed.json?.events?.[0];
    if (!event) continue;
    results.push({ path: parsed.json?.path ?? "", event });
  }
  return results;
}

describe("Manager event publishing", () => {
  let mockLogger: Logger;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    fetchMock = vi.fn(async () => new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("publishes process state changes in append oRPC shape", async () => {
    const config: ManagerConfig = {
      events: {
        callbackURL: "http://127.0.0.1:19010/orpc/append",
      },
      processes: [
        {
          name: "worker",
          definition: longRunningProcess,
          options: { restartPolicy: "never" },
        },
      ],
    };

    const manager = new Manager(config, mockLogger);
    try {
      await manager.start();

      await expect
        .poll(
          () => {
            const events = extractPostedEvents(fetchMock);
            return events.find(
              (entry) =>
                entry.event.type === "https://events.iterate.com/pidnap/process/state-changed",
            );
          },
          { timeout: 5000 },
        )
        .toBeDefined();

      const stateChanged = extractPostedEvents(fetchMock).find(
        (entry) => entry.event.type === "https://events.iterate.com/pidnap/process/state-changed",
      );

      expect(stateChanged?.path).toBe("/pidnap");
      expect(stateChanged?.event.version).toBe("1");
      expect(stateChanged?.event.payload.name).toBe("worker");
      expect(stateChanged?.event.payload.previousState).toBe("idle");
      expect(stateChanged?.event.payload.state).toBe("running");
      expect(stateChanged?.event.payload.eventId).toEqual(expect.any(String));
      expect(stateChanged?.event.payload.emittedAt).toEqual(expect.any(String));
      expect(stateChanged?.event.payload.sequence).toEqual(expect.any(Number));

      const emittedTypes = extractPostedEvents(fetchMock).map((entry) => entry.event.type);
      expect(
        emittedTypes.every(
          (type) => type === "https://events.iterate.com/pidnap/process/state-changed",
        ),
      ).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});
