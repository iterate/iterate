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

const tinyexecMock = vi.fn();
vi.mock("tinyexec", () => ({
  x: (...args: unknown[]) => tinyexecMock(...args),
}));

const { slackRouter } = await import("./slack.ts");

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    path: "/slack/ts-default",
    workingDirectory: "/workspace/repo",
    metadata: null,
    activeRoute: null,
    ...overrides,
  };
}

describe("slack router", () => {
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
    tinyexecMock.mockReset();
    tinyexecMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("new thread @mention (case 1)", () => {
    it("creates agent and sends new thread message when no agent exists", async () => {
      const ts = "1234567890.123456";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${ts.replace(".", "-")}` }),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_1",
        event: {
          type: "app_mention",
          ts,
          text: `<@${botUserId}> hello`,
          user: "U_USER",
          channel: "C_TEST",
          event_ts: ts,
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.case).toBe("new_thread_mention");
      expect(body.created).toBe(true);
      expect(getOrCreateAgentMock).toHaveBeenCalledTimes(1);
    });

    it("subscribes to agent changes when agent is newly created", async () => {
      const ts = "1234567890.111111";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${ts.replace(".", "-")}` }),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_sub",
        event: {
          type: "app_mention",
          ts,
          text: `<@${botUserId}> hello`,
          user: "U_USER",
          channel: "C_TEST",
          event_ts: ts,
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(subscribeToAgentChangesMock).toHaveBeenCalledTimes(1);
      expect(subscribeToAgentChangesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: expect.stringContaining("/slack/"),
          callbackUrl: expect.stringContaining("/agent-change-callback"),
        }),
      );
    });

    it("treats as mid-thread if agent already exists for 'new thread'", async () => {
      const ts = "1234567890.123456";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${ts.replace(".", "-")}` }),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_2",
        event: {
          type: "app_mention",
          ts,
          text: `<@${botUserId}> hello again`,
          user: "U_USER",
          channel: "C_TEST",
          event_ts: ts,
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.case).toBe("mid_thread_mention");
      expect(body.created).toBe(false);
      expect(subscribeToAgentChangesMock).not.toHaveBeenCalled();
    });
  });

  describe("mid-thread @mention (case 2)", () => {
    it("creates agent when mentioned in existing thread with no agent", async () => {
      const threadTs = "1234567890.123456";
      const ts = "1234567891.654321";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${threadTs.replace(".", "-")}` }),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_3",
        event: {
          type: "app_mention",
          thread_ts: threadTs,
          ts,
          text: `<@${botUserId}> can you help?`,
          user: "U_USER",
          channel: "C_TEST",
          event_ts: ts,
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.case).toBe("mid_thread_mention");
      expect(body.created).toBe(true);
    });

    it("uses existing agent when mentioned in thread with existing agent", async () => {
      const threadTs = "9999999999.999999";
      const ts = "9999999999.888888";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${threadTs.replace(".", "-")}` }),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_4",
        event: {
          type: "app_mention",
          thread_ts: threadTs,
          ts,
          channel: "C_TEST",
          user: "U_TEST",
          text: `<@${botUserId}> hello world`,
          event_ts: ts,
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.case).toBe("mid_thread_mention");
      expect(body.created).toBe(false);
    });
  });

  describe("FYI message (case 3)", () => {
    it("sends FYI message when no @mention but agent exists", async () => {
      const ts = "8888888888.888888";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getAgentMock.mockResolvedValue({ path: `/slack/ts-${ts.replace(".", "-")}` });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const payload = {
        type: "event_callback",
        event_id: "evt_5",
        event: {
          type: "message",
          ts,
          channel: "C_TEST",
          user: "U_TEST",
          text: "just a regular message without mention",
          event_ts: ts,
          channel_type: "channel",
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.case).toBe("fyi_message");
      expect(body.created).toBe(false);
      expect(getAgentMock).toHaveBeenCalledTimes(1);
      expect(getOrCreateAgentMock).not.toHaveBeenCalled();
    });

    it("ignores FYI message when no agent exists", async () => {
      const ts = "7777777777.777777";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getAgentMock.mockResolvedValue(null);

      const payload = {
        type: "event_callback",
        event_id: "evt_6",
        event: {
          type: "message",
          ts,
          channel: "C_TEST",
          user: "U_TEST",
          text: "just a regular message",
          event_ts: ts,
          channel_type: "channel",
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("no mention and no existing agent");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("ignored messages", () => {
    it("ignores bot messages (with bot_profile)", async () => {
      const ts = "6666666666.666666";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check

      const payload = {
        type: "event_callback",
        event_id: "evt_7",
        event: {
          type: "message",
          ts,
          channel: "C_TEST",
          user: botUserId,
          text: "bot response",
          bot_profile: { id: "B_BOT", name: "Test Bot" },
          event_ts: ts,
          channel_type: "channel",
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("bot message");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("ignores messages without bot authorization", async () => {
      const ts = "5555555555.555555";

      selectLimitQueue.push([]); // storeEvent dedup check

      const payload = {
        type: "event_callback",
        event_id: "evt_8",
        event: {
          type: "message",
          ts,
          channel: "C_TEST",
          user: "U_TEST",
          text: "message with no bot auth",
          event_ts: ts,
          channel_type: "channel",
        },
        authorizations: [],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("no bot user recipient");
    });

    it("ignores messages with no timestamp", async () => {
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check

      const payload = {
        type: "event_callback",
        event_id: "evt_9",
        event: {
          type: "message",
          channel: "C_TEST",
          user: "U_TEST",
          text: "message with no ts",
          channel_type: "channel",
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("no thread timestamp");
    });
  });

  describe("event deduplication", () => {
    it("returns early when event already exists in DB", async () => {
      const botUserId = "U_BOT";

      selectLimitQueue.push([{ id: "existing_evt_123" }]); // storeEvent finds existing

      const payload = {
        type: "event_callback",
        event_id: "evt_dup_db",
        event: {
          type: "app_mention",
          ts: "3333333333.333333",
          text: `<@${botUserId}> hello`,
          user: "U_USER",
          channel: "C_TEST",
          event_ts: "3333333333.333333",
        },
        authorizations: [{ user_id: botUserId, is_bot: true }],
      };

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("Duplicate");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getOrCreateAgentMock).not.toHaveBeenCalled();
    });
  });

  describe("!debug command", () => {
    it("handles !debug in-thread without forwarding prompt and posts debug details", async () => {
      const threadTs = "2121212121.212121";
      const botUserId = "U_BOT";
      const agentPath = `/slack/ts-${threadTs.replace(".", "-")}`;

      vi.stubEnv("ITERATE_OS_BASE_URL", "https://os.example.com");
      vi.stubEnv("ITERATE_ORG_SLUG", "my-org");
      vi.stubEnv("ITERATE_PROJECT_SLUG", "my-proj");
      vi.stubEnv("ITERATE_MACHINE_ID", "machine-123");
      vi.stubEnv("ITERATE_CUSTOMER_REPO_PATH", "/workspace/repo");

      selectLimitQueue.push([]); // storeEvent dedup check
      getAgentMock.mockResolvedValue({
        path: agentPath,
        workingDirectory: "/workspace/repo",
        metadata: null,
        activeRoute: {
          destination: "/opencode/sessions/sess_abc123",
          metadata: {
            agentHarness: "opencode",
            opencodeSessionId: "sess_abc123",
          },
        },
      });

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_debug_1",
          event: {
            type: "message",
            thread_ts: threadTs,
            ts: "2121212121.313131",
            text: "!debug",
            user: "U_USER",
            channel: "C_TEST",
            event_ts: "2121212121.313131",
            channel_type: "channel",
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.case).toBe("debug_command");
      expect(body.queued).toBe(false);

      expect(getAgentMock).toHaveBeenCalledTimes(1);
      expect(getAgentMock).toHaveBeenCalledWith({ path: agentPath });
      expect(getOrCreateAgentMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      const postMessageCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("chat.postMessage"),
      );
      expect(postMessageCall).toBeDefined();
      expect(postMessageCall![1][2]).toContain("sess_abc123");
      expect(postMessageCall![1][2]).toContain("Harness Web UI (direct proxy)");
      expect(postMessageCall![1][2]).toContain("terminal?command=");

      const removeCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("reactions.remove"),
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1][2]).toContain("thinking_face");
    });

    it("does not run !debug when no agent exists for non-mention FYI messages", async () => {
      const threadTs = "3131313131.313131";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getAgentMock.mockResolvedValue(null);

      const response = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_debug_2",
          event: {
            type: "message",
            thread_ts: threadTs,
            ts: "3131313131.414141",
            text: "!debug",
            user: "U_USER",
            channel: "C_TEST",
            event_ts: "3131313131.414141",
            channel_type: "channel",
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("no mention and no existing agent");

      const postMessageCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("chat.postMessage"),
      );
      expect(postMessageCall).toBeUndefined();

      expect(getOrCreateAgentMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("immediate emoji reaction", () => {
    it("sends eyes emoji immediately on @mention before getOrCreateAgent", async () => {
      const ts = "5050505050.111111";
      const botUserId = "U_BOT";

      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent({ path: `/slack/ts-${ts.replace(".", "-")}` }),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_imm_1",
          event: {
            type: "app_mention",
            ts,
            text: `<@${botUserId}> hello`,
            user: "U_USER",
            channel: "C_TEST",
            event_ts: ts,
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      // Flush fire-and-forget acknowledge
      await new Promise((resolve) => setTimeout(resolve, 0));

      const addCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("reactions.add"),
      );
      expect(addCall).toBeDefined();
      expect(addCall![1][2]).toContain(ts);
      expect(addCall![1][2]).toContain("eyes");
    });

    it("sends thinking_face emoji on FYI message after confirming agent exists", async () => {
      const ts = "5050505050.222222";
      const botUserId = "U_BOT";
      const agentPath = `/slack/ts-${ts.replace(".", "-")}`;

      selectLimitQueue.push([]); // storeEvent dedup check
      getAgentMock.mockResolvedValue({ path: agentPath });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_imm_2",
          event: {
            type: "message",
            ts,
            channel: "C_TEST",
            user: "U_TEST",
            text: "just a message in thread",
            event_ts: ts,
            channel_type: "channel",
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      // Flush fire-and-forget acknowledge
      await new Promise((resolve) => setTimeout(resolve, 0));

      const addCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("reactions.add"),
      );
      expect(addCall).toBeDefined();
      expect(addCall![1][2]).toContain(ts);
      expect(addCall![1][2]).toContain("thinking_face");
    });
  });

  describe("emoji guard", () => {
    it("does not clobber emoji context when second webhook arrives for same thread", async () => {
      const threadTs = "4444444444.444444";
      const secondTs = "4444444444.555555";
      const botUserId = "U_BOT";
      const agentPath = `/slack/ts-${threadTs.replace(".", "-")}`;

      // ── First webhook: new thread mention ──
      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: true,
        route: null,
        agent: buildAgent({ path: agentPath }),
      });
      subscribeToAgentChangesMock.mockResolvedValue({});
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_guard_1",
          event: {
            type: "app_mention",
            ts: threadTs,
            text: `<@${botUserId}> first message`,
            user: "U_USER",
            channel: "C_TEST",
            event_ts: threadTs,
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      // Flush fire-and-forget acknowledge from first webhook
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Verify eyes emoji was added for the first message
      const addCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("reactions.add"),
      );
      expect(addCall).toBeDefined();
      expect(addCall![1][2]).toContain(threadTs);

      // ── Second webhook: mid-thread mention (same thread, different message) ──
      selectLimitQueue.push([]); // storeEvent dedup check
      getOrCreateAgentMock.mockResolvedValue({
        wasNewlyCreated: false,
        route: null,
        agent: buildAgent({ path: agentPath }),
      });
      fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

      const response2 = await slackRouter.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "evt_guard_2",
          event: {
            type: "app_mention",
            thread_ts: threadTs,
            ts: secondTs,
            text: `<@${botUserId}> second message`,
            user: "U_USER",
            channel: "C_TEST",
            event_ts: secondTs,
          },
          authorizations: [{ user_id: botUserId, is_bot: true }],
        }),
      });

      // Second webhook still succeeds — prompt is sent, emoji tracking is skipped.
      expect(response2.status).toBe(200);
      expect((await response2.json()).queued).toBe(true);

      // ── Agent goes idle: callback should use FIRST message's emoji context ──
      const callbackResponse = await slackRouter.request("/agent-change-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "iterate:agent-updated",
          payload: { path: agentPath, shortStatus: "", isWorking: false },
        }),
      });

      const callbackBody = await callbackResponse.json();
      expect(callbackBody.success).toBe(true);
      expect(callbackBody.ignored).toBeUndefined();

      // Verify unacknowledge removed the reaction from the FIRST message, not the second.
      const removeCall = tinyexecMock.mock.calls.find(
        (call: unknown[]) =>
          Array.isArray(call[1]) &&
          typeof call[1][2] === "string" &&
          call[1][2].includes("reactions.remove"),
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1][2]).toContain(threadTs);
      expect(removeCall![1][2]).not.toContain(secondTs);
    });
  });
});
