import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent } from "../db/schema.ts";

vi.mock("../services/agent-manager.ts", () => ({
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  appendToAgent: vi.fn(),
}));

// Mock the database to avoid needing migrations in tests
vi.mock("../db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  },
}));

// Mock platform to provide customer repo path
vi.mock("../trpc/platform.ts", () => ({
  getCustomerRepoPath: vi.fn(() => "/home/iterate/src/github.com/customer/repo"),
}));

const { slackRouter } = await import("./slack.ts");
const { getAgent, createAgent, appendToAgent } = await import("../services/agent-manager.ts");

const mockedGetAgent = vi.mocked(getAgent);
const mockedCreateAgent = vi.mocked(createAgent);
const mockedAppendToAgent = vi.mocked(appendToAgent);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date();
  return {
    id: "agent-1",
    slug: "slack-123",
    harnessType: "opencode",
    harnessSessionId: "opencode-session-123",
    tmuxSession: "tmux-1",
    workingDirectory: "/home/iterate/src/github.com/iterate/iterate",
    status: "running",
    initialPrompt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

describe("slack router", () => {
  beforeEach(() => {
    mockedGetAgent.mockReset();
    mockedCreateAgent.mockReset();
    mockedAppendToAgent.mockReset();
  });

  describe("new thread @mention (case 1)", () => {
    it("creates agent and sends new thread message when no agent exists", async () => {
      const ts = "1234567890.123456"; // No thread_ts means new thread
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      mockedGetAgent.mockResolvedValue(null);
      mockedCreateAgent.mockResolvedValue(agent);

      const payload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          ts, // No thread_ts - this is a new thread
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
      expect(mockedCreateAgent).toHaveBeenCalled();
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("You've been mentioned to start a new conversation"),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
      expect(mockedAppendToAgent).toHaveBeenCalledWith(agent, expect.stringContaining("channel="), {
        workingDirectory: "/home/iterate/src/github.com/customer/repo",
      });
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("thread_ts="),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
    });

    it("treats as mid-thread if agent already exists for 'new thread'", async () => {
      const ts = "1234567890.123456";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      mockedGetAgent.mockResolvedValue(agent); // Agent already exists

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
      expect(body.case).toBe("mid_thread_mention"); // Treated as mid-thread
      expect(body.created).toBe(false);
      expect(mockedCreateAgent).not.toHaveBeenCalled();
    });
  });

  describe("mid-thread @mention (case 2)", () => {
    it("creates agent when mentioned in existing thread with no agent", async () => {
      const threadTs = "1234567890.123456";
      const ts = "1234567891.654321";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

      mockedGetAgent.mockResolvedValue(null);
      mockedCreateAgent.mockResolvedValue(agent);

      const payload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          thread_ts: threadTs, // Has thread_ts - this is a reply
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
      expect(mockedCreateAgent).toHaveBeenCalled();
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("You've been mentioned in an existing thread"),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
    });

    it("uses existing agent when mentioned in thread with existing agent", async () => {
      const threadTs = "9999999999.999999";
      const ts = "9999999999.888888";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

      mockedGetAgent.mockResolvedValue(agent);

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
      expect(mockedCreateAgent).not.toHaveBeenCalled();
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("You've been mentioned in an existing thread"),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
    });
  });

  describe("FYI message (case 3)", () => {
    it("sends FYI message when no @mention but agent exists", async () => {
      const ts = "8888888888.888888";
      const botUserId = "U_BOT";
      const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

      mockedGetAgent.mockResolvedValue(agent);

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
      expect(mockedCreateAgent).not.toHaveBeenCalled();
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("FYI: Another message in this thread"),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
      expect(mockedAppendToAgent).toHaveBeenCalledWith(
        agent,
        expect.stringContaining("you were not @mentioned"),
        { workingDirectory: "/home/iterate/src/github.com/customer/repo" },
      );
    });

    it("ignores FYI message when no agent exists", async () => {
      const ts = "7777777777.777777";
      const botUserId = "U_BOT";

      mockedGetAgent.mockResolvedValue(null);

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
      expect(mockedCreateAgent).not.toHaveBeenCalled();
      expect(mockedAppendToAgent).not.toHaveBeenCalled();
    });
  });

  describe("ignored messages", () => {
    it("ignores bot messages (with bot_profile)", async () => {
      const ts = "6666666666.666666";
      const botUserId = "U_BOT";

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
      expect(mockedGetAgent).not.toHaveBeenCalled();
      expect(mockedCreateAgent).not.toHaveBeenCalled();
      expect(mockedAppendToAgent).not.toHaveBeenCalled();
    });

    it("ignores messages without bot authorization", async () => {
      const ts = "5555555555.555555";

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
        authorizations: [], // No bot authorization
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
  });
});
