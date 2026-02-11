import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const selectLimitQueue: unknown[][] = [];

const getOrCreateAgentMock = vi.fn();
const getAgentMock = vi.fn();
const subscribeToAgentChangesMock = vi.fn();

vi.mock("../trpc/router.ts", () => ({
  trpcRouter: {
    createCaller: vi.fn(() => ({
      getOrCreateAgent: getOrCreateAgentMock,
      getAgent: getAgentMock,
      subscribeToAgentChanges: subscribeToAgentChangesMock,
    })),
  },
}));

vi.mock("../db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(selectLimitQueue.shift() ?? [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  },
}));

const { webchatRouter } = await import("./webchat.ts");

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    path: "/webchat/thread-default",
    workingDirectory: "/workspace/repo",
    metadata: null,
    activeRoute: null,
    ...overrides,
  };
}

describe("webchat router", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    selectLimitQueue.length = 0;
    fetchSpy.mockReset();
    getOrCreateAgentMock.mockReset();
    getAgentMock.mockReset();
    subscribeToAgentChangesMock.mockReset();
    getOrCreateAgentMock.mockResolvedValue({
      wasNewlyCreated: false,
      route: null,
      agent: buildAgent(),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("/webhook — new message (no duplicate)", () => {
    it("creates agent and returns success for new thread", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent(),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello from webchat", userId: "u1", userName: "Alice" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.duplicate).toBe(false);
      expect(body.created).toBe(true);
      expect(body.threadId).toBeDefined();
      expect(body.messageId).toBeDefined();
      expect(body.eventId).toBeDefined();
    });

    it("does not subscribe when agent already existed", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({ path: "/webchat/thread-existing" }),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Follow-up", threadId: "thread-existing" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.created).toBe(false);
      expect(body.threadId).toBe("thread-existing");
      expect(subscribeToAgentChangesMock).not.toHaveBeenCalled();
    });

    it("subscribes to agent changes when agent is newly created", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent(),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "New thread" }),
      });

      expect(subscribeToAgentChangesMock).toHaveBeenCalledTimes(1);
      expect(subscribeToAgentChangesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: expect.stringContaining("/webchat/"),
          callbackUrl: expect.stringContaining("/agent-change-callback"),
        }),
      );
    });

    it("preserves provided threadId", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({ path: "/webchat/my-thread-42" }),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "msg", threadId: "my-thread-42" }),
      });

      const body = await response.json();
      expect(body.threadId).toBe("my-thread-42");
    });

    it("preserves provided messageId", async () => {
      selectLimitQueue.push([]); // duplicate check: not found
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent(),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "msg", messageId: "custom-msg-1" }),
      });

      const body = await response.json();
      expect(body.messageId).toBe("custom-msg-1");
    });
  });

  describe("/webhook — duplicate detection", () => {
    it("returns duplicate when messageId already stored", async () => {
      selectLimitQueue.push([{ id: "evt_existing" }]);

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "dup", messageId: "msg_already_stored", threadId: "t1" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.duplicate).toBe(true);
      expect(body.threadId).toBe("t1");
      expect(getOrCreateAgentMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips duplicate check when no messageId provided", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent(),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "no messageId" }),
      });

      expect(response.status).toBe(200);
      // selectLimitQueue was empty — if a select were attempted it would return []
      // but since no messageId, no select should happen at all
      expect(getOrCreateAgentMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("/webhook — validation", () => {
    it("rejects empty text with no attachments", async () => {
      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("text or attachments");
    });

    it("rejects missing text with no attachments", async () => {
      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("text or attachments");
    });

    it("accepts message with only attachments (no text)", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent(),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachments: [{ fileName: "test.png", filePath: "/tmp/test.png", mimeType: "image/png" }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it("rejects invalid payload types", async () => {
      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: 12345 }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid");
    });
  });

  describe("/webhook — agent commands", () => {
    it("handles !debug without forwarding to agent prompt", async () => {
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({
          path: "/webchat/thread-debug",
          activeRoute: {
            destination: "/opencode/sessions/sess_debug",
            metadata: {
              agentHarness: "opencode",
              opencodeSessionId: "sess_debug",
            },
          },
        }),
      });

      const response = await webchatRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "!debug",
          threadId: "thread-debug",
          messageId: "msg-debug-1",
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.case).toBe("debug_command");
      expect(body.queued).toBe(false);
      expect(body.created).toBe(false);
      expect(body.assistantMessageId).toBeDefined();
      expect(body.assistantEventId).toBeDefined();

      expect(getOrCreateAgentMock).toHaveBeenCalledWith({
        agentPath: "/webchat/thread-debug",
        createWithEvents: [],
      });
      expect(getAgentMock).not.toHaveBeenCalled();
      expect(subscribeToAgentChangesMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
