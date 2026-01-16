import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent } from "../db/schema.ts";

vi.mock("../services/agent-manager.ts", () => ({
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  appendToAgent: vi.fn(),
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

  it("returns 400 when no thread id can be extracted", async () => {
    const payload = { type: "event_callback", event: { type: "message", text: "no ts" } };

    const response = await slackRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("thread_id");
  });

  it("creates agent on @mention when no agent exists", async () => {
    const threadTs = "1234567890.123456";
    const botUserId = "U_BOT";
    const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });

    mockedGetAgent.mockResolvedValue(null);
    mockedCreateAgent.mockResolvedValue(agent);

    const payload = {
      type: "event_callback",
      event: {
        type: "app_mention",
        thread_ts: threadTs,
        text: `<@${botUserId}> hello`,
        user: "U_USER",
        channel: "C_TEST",
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
    expect(body.agentSlug).toBe(`slack-${threadTs.replace(".", "-")}`);
    expect(body.created).toBe(true);
    expect(mockedCreateAgent).toHaveBeenCalled();
    expect(mockedAppendToAgent).toHaveBeenCalledWith(agent, expect.stringContaining("hello"));
    expect(mockedAppendToAgent).toHaveBeenCalledWith(
      agent,
      expect.stringContaining("Before responding, use the following CLI command"),
    );
  });

  it("sends @mention message to existing agent without creating new one", async () => {
    const ts = "9999999999.999999";
    const botUserId = "U_BOT";
    const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });

    mockedGetAgent.mockResolvedValue(agent);

    const payload = {
      type: "event_callback",
      event: {
        type: "app_mention",
        ts,
        channel: "C_TEST",
        user: "U_TEST",
        text: `<@${botUserId}> hello world`,
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
    expect(body.created).toBe(false);
    expect(mockedCreateAgent).not.toHaveBeenCalled();
    expect(mockedAppendToAgent).toHaveBeenCalledWith(
      agent,
      [
        `New Slack message from <@U_TEST> in C_TEST: <@${botUserId}> hello world`,
        "",
        "Before responding, use the following CLI command to reply to the message:",
        '`iterate tool send-slack-message --channel C_TEST --thread-ts 9999999999.999999 --message "<your response here>"` ',
      ].join("\n"),
    );
  });

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
    expect(body.fyi).toBe(true);
    expect(mockedCreateAgent).not.toHaveBeenCalled();
    expect(mockedAppendToAgent).toHaveBeenCalledWith(
      agent,
      expect.stringContaining("FYI, there was another message"),
    );
    expect(mockedAppendToAgent).toHaveBeenCalledWith(
      agent,
      expect.stringContaining("If you are SURE this is a direct question to you"),
    );
  });

  it("ignores message when no @mention and no agent exists", async () => {
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

  it("ignores bot messages", async () => {
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
});
