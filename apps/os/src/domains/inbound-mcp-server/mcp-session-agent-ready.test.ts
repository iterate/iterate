import { describe, expect, it, vi } from "vitest";
import { MCP_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("explicitly creates the session agent and waits for create to return", async () => {
    const created = Promise.withResolvers<void>();
    const create = vi.fn(() => created.promise);
    const snapshot = vi.fn().mockResolvedValue({ state: { birthCertificate: null } });
    let requestedPath: string | undefined;

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get(path) {
            requestedPath = path;
            return { create, processor: { snapshot } };
          },
        },
      },
    });

    await Promise.resolve();

    expect(requestedPath).toBe("/agents/mcp/session-test");
    expect(snapshot).toHaveBeenCalledOnce();
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

  it("does not try to recreate an existing session agent", async () => {
    const create = vi.fn();
    const snapshot = vi.fn().mockResolvedValue({
      state: { birthCertificate: { config: { systemPrompt: "original" } } },
    });

    await ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get: () => ({ create, processor: { snapshot } }),
        },
      },
    });

    expect(snapshot).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});
