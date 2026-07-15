import { describe, expect, it, vi } from "vitest";
import { MCP_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("explicitly creates the session agent and waits for create to return", async () => {
    const created = Promise.withResolvers<void>();
    const create = vi.fn(() => created.promise);
    let requestedPath: string | undefined;

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get(path) {
            requestedPath = path;
            return { create };
          },
        },
      },
    });

    await Promise.resolve();

    expect(requestedPath).toBe("/agents/mcp/session-test");
    expect(create).toHaveBeenCalledWith({ systemPrompt: MCP_AGENT_SYSTEM_PROMPT });

    let returned = false;
    void ready.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    created.resolve();
    await ready;

    expect(returned).toBe(true);
  });
});
