import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the local db module
vi.mock("./db.ts", () => ({
  storeEvent: vi.fn(),
  eventExists: vi.fn(() => false),
  findThreadTs: vi.fn(),
}));

// Import after mocking
const { slackRouter } = await import("./router.ts");
const { eventExists, findThreadTs } = await import("./db.ts");

const mockedEventExists = vi.mocked(eventExists);
const mockedFindThreadTs = vi.mocked(findThreadTs);

interface Agent {
  id: string;
  slug: string;
  status: string;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    slug: "slack-123",
    status: "running",
    ...overrides,
  };
}

// Helper to mock fetch for tRPC calls
function mockTrpcFetch(options: { getAgent?: Agent | null; createAgent?: Agent }) {
  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/api/trpc/getAgent")) {
      return new Response(JSON.stringify({ result: { data: options.getAgent ?? null } }), {
        status: 200,
      });
    }

    if (urlStr.includes("/api/trpc/createAgent")) {
      return new Response(JSON.stringify({ result: { data: options.createAgent } }), {
        status: 200,
      });
    }

    if (urlStr.includes("/api/trpc/startAgent")) {
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

describe("slack router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEventExists.mockReturnValue(false);
  });

  describe("new thread @mention (case 1)", () => {
    it("creates agent and sends new thread message when no agent exists", async () => {
      const ts = "1234567890.123456";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      const mockFetch = mockTrpcFetch({ getAgent: null, createAgent: agent });

      const payload = {
        type: "event_callback",
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

      // Verify createAgent was called
      const createCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/createAgent"),
      );
      expect(createCall).toBeDefined();

      // Verify appendToAgent (startAgent) was called with message
      const appendCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/startAgent"),
      );
      expect(appendCall).toBeDefined();
      const appendBody = JSON.parse(appendCall![1]?.body as string);
      expect(appendBody.initialPrompt).toContain(
        "You've been mentioned to start a new conversation",
      );
    });

    it("treats as mid-thread if agent already exists for 'new thread'", async () => {
      const ts = "1234567890.123456";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      const mockFetch = mockTrpcFetch({ getAgent: agent });

      const payload = {
        type: "event_callback",
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

      // Verify createAgent was NOT called
      const createCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/createAgent"),
      );
      expect(createCall).toBeUndefined();
    });
  });

  describe("mid-thread @mention (case 2)", () => {
    it("creates agent when mentioned in existing thread with no agent", async () => {
      const threadTs = "1234567890.123456";
      const ts = "1234567891.654321";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

      const mockFetch = mockTrpcFetch({ getAgent: null, createAgent: agent });

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.case).toBe("mid_thread_mention");
      expect(body.created).toBe(true);

      // Verify appendToAgent was called with mid-thread message
      const appendCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/startAgent"),
      );
      expect(appendCall).toBeDefined();
      const appendBody = JSON.parse(appendCall![1]?.body as string);
      expect(appendBody.initialPrompt).toContain("You've been mentioned in an existing thread");
    });

    it("uses existing agent when mentioned in thread with existing agent", async () => {
      const threadTs = "9999999999.999999";
      const ts = "9999999999.888888";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

      const mockFetch = mockTrpcFetch({ getAgent: agent });

      const payload = {
        type: "event_callback",
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

      // Verify createAgent was NOT called
      const createCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/createAgent"),
      );
      expect(createCall).toBeUndefined();
    });
  });

  describe("FYI message (case 3)", () => {
    it("sends FYI message when no @mention but agent exists", async () => {
      const ts = "8888888888.888888";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      const mockFetch = mockTrpcFetch({ getAgent: agent });

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.case).toBe("fyi_message");

      // Verify appendToAgent was called with FYI message
      const appendCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/startAgent"),
      );
      expect(appendCall).toBeDefined();
      const appendBody = JSON.parse(appendCall![1]?.body as string);
      expect(appendBody.initialPrompt).toContain("FYI: Another message in this thread");
      expect(appendBody.initialPrompt).toContain("you were not @mentioned");
    });

    it("ignores FYI message when no agent exists", async () => {
      const ts = "7777777777.777777";
      const botUserId = "U_BOT";

      mockTrpcFetch({ getAgent: null });

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.message).toContain("no mention and no existing agent");
    });
  });

  describe("ignored messages", () => {
    it("ignores bot messages (with bot_profile)", async () => {
      const ts = "6666666666.666666";
      const botUserId = "U_BOT";

      const mockFetch = mockTrpcFetch({});

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.message).toContain("bot message");

      // Verify no tRPC calls were made (except potentially for event storage)
      const agentCalls = mockFetch.mock.calls.filter(
        (call) =>
          call[0].toString().includes("/api/trpc/getAgent") ||
          call[0].toString().includes("/api/trpc/createAgent") ||
          call[0].toString().includes("/api/trpc/startAgent"),
      );
      expect(agentCalls.length).toBe(0);
    });

    it("ignores messages without bot authorization", async () => {
      const ts = "5555555555.555555";

      mockTrpcFetch({});

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.message).toContain("no bot user recipient");
    });

    it("ignores messages with no timestamp", async () => {
      const botUserId = "U_BOT";

      mockTrpcFetch({});

      const payload = {
        type: "event_callback",
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
      expect(body.success).toBe(true);
      expect(body.message).toContain("no thread timestamp");
    });

    it("ignores duplicate events", async () => {
      const ts = "4444444444.444444";
      const botUserId = "U_BOT";

      mockedEventExists.mockReturnValue(true);
      mockTrpcFetch({});

      const payload = {
        type: "event_callback",
        event_id: "Ev123456",
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
      expect(body.message).toContain("Duplicate event");
    });
  });

  describe("reaction events", () => {
    it("forwards reaction_added to existing agent", async () => {
      const threadTs = "3333333333.333333";
      const messageTs = "3333333333.444444";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

      mockedFindThreadTs.mockReturnValue(threadTs);
      const mockFetch = mockTrpcFetch({ getAgent: agent });

      const payload = {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: "U_USER",
          reaction: "thumbsup",
          item: { type: "message", channel: "C_TEST", ts: messageTs },
          event_ts: "3333333333.555555",
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
      expect(body.case).toBe("reaction_added");

      // Verify appendToAgent was called with reaction message
      const appendCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes("/api/trpc/startAgent"),
      );
      expect(appendCall).toBeDefined();
      const appendBody = JSON.parse(appendCall![1]?.body as string);
      expect(appendBody.initialPrompt).toContain("Reaction added");
      expect(appendBody.initialPrompt).toContain(":thumbsup:");
    });

    it("ignores reaction when no agent exists for thread", async () => {
      const threadTs = "2222222222.222222";
      const messageTs = "2222222222.333333";
      const botUserId = "U_BOT";

      mockedFindThreadTs.mockReturnValue(threadTs);
      mockTrpcFetch({ getAgent: null });

      const payload = {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: "U_USER",
          reaction: "thumbsup",
          item: { type: "message", channel: "C_TEST", ts: messageTs },
          event_ts: "2222222222.444444",
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
      expect(body.message).toContain("no agent for this thread");
    });

    it("ignores reaction when thread cannot be found", async () => {
      const messageTs = "1111111111.222222";
      const botUserId = "U_BOT";

      mockedFindThreadTs.mockReturnValue(null);
      mockTrpcFetch({});

      const payload = {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: "U_USER",
          reaction: "thumbsup",
          item: { type: "message", channel: "C_TEST", ts: messageTs },
          event_ts: "1111111111.333333",
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
      expect(body.message).toContain("could not find thread");
    });
  });
});
