import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateAgent = vi.fn();
const getActiveRoute = vi.fn();

vi.mock("../trpc/router.ts", () => ({
  trpcRouter: {
    createCaller: vi.fn(() => ({
      getOrCreateAgent,
      getActiveRoute,
    })),
  },
}));

const { agentsRouter } = await import("./agents.ts");

describe("agents router", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    getOrCreateAgent.mockReset();
    getActiveRoute.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("forwards upstream even when route is newly created", async () => {
    getOrCreateAgent.mockResolvedValue({
      route: { destination: "pending" },
      wasCreated: true,
    });
    getActiveRoute.mockResolvedValue({ destination: "/opencode/sessions/new-session" });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, sessionId: "new-session" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await agentsRouter.request("/api/agents/slack/thread-123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, sessionId: "new-session" });
    expect(getOrCreateAgent).toHaveBeenCalledWith({
      agentPath: "/slack/thread-123",
      createWithEvents: [],
      newAgentPath: "/opencode/new",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/opencode/sessions/new-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "hello" }),
      },
    );
  });

  it("returns 400 for invalid path", async () => {
    const response = await agentsRouter.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "hello" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid agent path" });
  });
});
