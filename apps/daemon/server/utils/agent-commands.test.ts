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
    vi.stubEnv("ITERATE_OS_BASE_URL", "https://os.example.com");
    vi.stubEnv("ITERATE_ORG_SLUG", "my-org");
    vi.stubEnv("ITERATE_PROJECT_SLUG", "my-proj");
    vi.stubEnv("ITERATE_MACHINE_ID", "machine-123");
    vi.stubEnv("ITERATE_CUSTOMER_REPO_PATH", "/workspace/repo");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns renderer-agnostic debug markdown with plain links", async () => {
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
        agent,
      }),
    );
    expect(result?.resultMarkdown).toContain("Harness Web UI (direct proxy): https://");
    expect(result?.resultMarkdown).toContain("Open Terminal UI: https://");
    expect(result?.resultMarkdown).not.toContain("|Open session>");
    expect(result?.resultMarkdown).not.toContain("|Open terminal attach>");
  });
});
