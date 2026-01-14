import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent } from "../db/schema.ts";

vi.mock("../services/agent-manager.ts", () => ({
  getOrCreateAgent: vi.fn(),
  appendToAgent: vi.fn(),
}));

const { slackRouter } = await import("./slack.ts");
const { getOrCreateAgent, appendToAgent } = await import("../services/agent-manager.ts");

const mockedGetOrCreateAgent = vi.mocked(getOrCreateAgent);
const mockedAppendToAgent = vi.mocked(appendToAgent);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date();
  return {
    id: "agent-1",
    slug: "slack-123",
    harnessType: "opencode",
    harnessSessionId: "opencode-session-123",
    tmuxSession: "tmux-1",
    workingDirectory: "/root/src/github.com/iterate/iterate",
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
    mockedGetOrCreateAgent.mockReset();
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

  it("creates agent and returns slug for new thread", async () => {
    const threadTs = "1234567890.123456";
    const agent = makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` });
    mockedGetOrCreateAgent.mockResolvedValue({
      agent,
      wasCreated: true,
    });

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        thread_ts: threadTs,
        text: "hello",
      },
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
    // Message is always sent via appendToAgent
    expect(mockedAppendToAgent).toHaveBeenCalledWith(agent, expect.stringContaining("hello"));
  });

  it("sends message to existing agent when thread already exists", async () => {
    const ts = "9999999999.999999";
    const agent = makeAgent({ slug: `slack-${ts.replace(".", "-")}` });
    mockedGetOrCreateAgent.mockResolvedValue({
      agent,
      wasCreated: false,
    });

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        ts,
        channel: "C_TEST",
        user: "U_TEST",
        text: "hello world",
      },
    };

    const response = await slackRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(false);
    expect(mockedAppendToAgent).toHaveBeenCalledWith(
      agent,
      "New Slack message from <@U_TEST> in C_TEST: hello world",
    );
  });
});
