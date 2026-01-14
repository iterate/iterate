import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent } from "../db/schema.ts";

vi.mock("../services/agent-manager.ts", () => ({
  ensureAgentRunning: vi.fn(),
  sendMessageToAgent: vi.fn(),
}));

const { slackRouter } = await import("./slack.ts");
const { ensureAgentRunning, sendMessageToAgent } = await import("../services/agent-manager.ts");

const mockedEnsureAgentRunning = vi.mocked(ensureAgentRunning);
const mockedSendMessageToAgent = vi.mocked(sendMessageToAgent);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date();
  return {
    id: "agent-1",
    slug: "slack-123",
    harnessType: "pi",
    harnessSessionId: null,
    tmuxSession: "tmux-1",
    workingDirectory: "/tmp",
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
    mockedEnsureAgentRunning.mockReset();
    mockedSendMessageToAgent.mockReset();
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
    mockedEnsureAgentRunning.mockResolvedValue({
      agent: makeAgent({ slug: `slack-${threadTs.replace(".", "-")}` }),
      wasCreated: true,
      tmuxSession: "tmux-1",
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
    expect(mockedSendMessageToAgent).not.toHaveBeenCalled();
  });

  it("sends message to existing agent when thread already exists", async () => {
    const ts = "9999999999.999999";
    mockedEnsureAgentRunning.mockResolvedValue({
      agent: makeAgent({ slug: `slack-${ts.replace(".", "-")}` }),
      wasCreated: false,
      tmuxSession: "tmux-1",
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
    expect(mockedSendMessageToAgent).toHaveBeenCalledWith(
      "tmux-1",
      "New Slack message from <@U_TEST> in C_TEST: hello world",
      "pi",
    );
  });
});
