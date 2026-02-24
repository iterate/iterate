import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyPatches = vi.fn(async () => ({ success: true }));
const list = vi.fn(async () => []);
const get = vi.fn(async (input: unknown) => input);
const status = vi.fn(async () => ({ state: "running", processCount: 1 }));

vi.mock("pidnap/client", () => ({
  createClient: vi.fn(() => ({
    manager: { status },
    processes: {
      list,
      get,
      applyPatches,
    },
  })),
}));

const { pidnapRouter } = await import("./pidnap.ts");

describe("pidnapRouter", () => {
  beforeEach(() => {
    applyPatches.mockClear();
    list.mockClear();
    get.mockClear();
    status.mockClear();
  });

  it("forwards applyProcessPatches to pidnap client", async () => {
    const caller = createRouterClient(pidnapRouter, { context: {} });
    const payload = {
      upserts: {
        "daemon-backend": {
          definition: { command: "node", args: ["server.js"] },
          persistence: "durable" as const,
          desiredState: "running" as const,
        },
      },
      deletes: ["opencode"],
    };

    await caller.applyProcessPatches(payload);
    expect(applyPatches).toHaveBeenCalledWith(payload);
  });
});
