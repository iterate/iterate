import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedAgent } from "../routers/agents.ts";
import { runAgentCommand } from "./agent-commands.ts";

function buildAgent(overrides: Partial<SerializedAgent> = {}): SerializedAgent {
  const base: SerializedAgent = {
    path: "/webchat/thread-debug",
    metadata: null,
    shortStatus: "",
    isWorking: false,
    workingDirectory: "/workspace/repo",
    createdAt: null,
    updatedAt: null,
    archivedAt: null,
    activeRoute: {
      id: 1,
      agentPath: "/webchat/thread-debug",
      destination: "/opencode/sessions/sess_debug",
      metadata: {
        agentHarness: "opencode",
        opencodeSessionId: "sess_debug",
      },
      active: true,
      createdAt: null,
      updatedAt: null,
    },
  };

  return { ...base, ...overrides };
}

describe("runAgentCommand", () => {
  beforeEach(() => {
    vi.stubEnv("ITERATE_PROJECT_BASE_URL", "https://my-proj.iterate.app");
    vi.stubEnv("ITERATE_CUSTOMER_REPO_PATH", "/workspace/repo");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns structured debug result with canonical ingress URLs", async () => {
    const agent = buildAgent();
    const result = await runAgentCommand({
      message: "!debug",
      agentPath: agent.path,
      agent,
    });

    expect(result).not.toBeNull();
    expect(result?.command).toBe("debug");
    expect(result?.result).toEqual(
      expect.objectContaining({
        agentPath: agent.path,
        agentHarness: "opencode",
        sessionSource: "route.metadata",
        agent,
      }),
    );

    const r = result?.result as { webUrl: string; terminalUrl: string };
    expect(r.webUrl).toContain("4096__my-proj.iterate.app");
    expect(r.terminalUrl).toContain("my-proj.iterate.app");
    expect(result?.resultMarkdown).toContain("Harness Web UI (direct proxy): https://");
    expect(result?.resultMarkdown).toContain("Open Terminal UI: https://");
  });

  it("recognizes /debug alias", async () => {
    const agent = buildAgent();
    const result = await runAgentCommand({
      message: "/debug",
      agentPath: agent.path,
      agent,
    });
    expect(result?.command).toBe("debug");
  });

  it("returns null for non-command messages", async () => {
    const agent = buildAgent();
    const result = await runAgentCommand({
      message: "hello world",
      agentPath: agent.path,
      agent,
    });
    expect(result).toBeNull();
  });

  it("strips @mention prefixes before matching", async () => {
    const agent = buildAgent();
    const result = await runAgentCommand({
      message: "<@U123ABC> !debug",
      agentPath: agent.path,
      agent,
    });
    expect(result?.command).toBe("debug");
  });
});
