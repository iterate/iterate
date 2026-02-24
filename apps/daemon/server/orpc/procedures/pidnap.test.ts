import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateConfig = vi.fn(async () => ({ success: true }));
const deleteProcess = vi.fn(async () => ({ success: true }));
const list = vi.fn(async () => []);
const get = vi.fn(async (input: unknown) => input);
const status = vi.fn(async () => ({ state: "running", processCount: 1 }));

vi.mock("pidnap/client", () => ({
  createClient: vi.fn(() => ({
    manager: { status },
    processes: {
      list,
      get,
      updateConfig,
      delete: deleteProcess,
    },
  })),
}));

const { pidnapRouter } = await import("./pidnap.ts");

describe("pidnapRouter", () => {
  beforeEach(() => {
    updateConfig.mockClear();
    deleteProcess.mockClear();
    list.mockClear();
    get.mockClear();
    status.mockClear();
  });

  it("forwards updateConfig to pidnap client", async () => {
    const caller = createRouterClient(pidnapRouter, { context: {} });
    const payload = {
      processSlug: "daemon-backend",
      config: {
        definition: { command: "node", args: ["server.js"] },
        persistence: "durable" as const,
        desiredState: "running" as const,
      },
    };

    await caller.updateConfig(payload);
    expect(updateConfig).toHaveBeenCalledWith({
      processSlug: "daemon-backend",
      definition: { command: "node", args: ["server.js"] },
      persistence: "durable",
      desiredState: "running",
    });
  });

  it("forwards delete to pidnap client", async () => {
    const caller = createRouterClient(pidnapRouter, { context: {} });
    await caller.delete({ processSlug: "opencode" });
    expect(deleteProcess).toHaveBeenCalledWith({ processSlug: "opencode" });
  });
});
