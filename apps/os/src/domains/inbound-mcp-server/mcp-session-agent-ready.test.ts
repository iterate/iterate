import { describe, expect, it, vi } from "vitest";
import { MCP_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("explicitly creates the session agent and waits for create to return", async () => {
    const created = Promise.withResolvers<void>();
    const create = vi.fn(() => created.promise);
    const append = vi.fn().mockResolvedValue([]);
    const snapshot = vi.fn().mockResolvedValue({ state: { birthCertificate: null } });
    let requestedPath: string | undefined;

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get(path) {
            requestedPath = path;
            return { create, processor: { snapshot }, stream: { append } };
          },
        },
      },
    });

    await Promise.resolve();

    expect(requestedPath).toBe("/agents/mcp/session-test");
    expect(snapshot).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith();
    expect(append).not.toHaveBeenCalled();

    let returned = false;
    void ready.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    created.resolve();
    await ready;

    expect(returned).toBe(true);
    expect(append).toHaveBeenCalledWith({
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: expect.stringMatching(/^agent\/mcp-system-prompt:[0-9a-f]{16}$/),
      payload: {
        role: "system",
        key: "agent/system-prompt",
        content: MCP_AGENT_SYSTEM_PROMPT,
      },
    });
  });

  it("does not try to recreate an existing session agent", async () => {
    const create = vi.fn();
    const append = vi.fn().mockResolvedValue([]);
    const snapshot = vi.fn().mockResolvedValue({
      state: { birthCertificate: { config: { systemPrompt: "original" } } },
    });

    await ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get: () => ({ create, processor: { snapshot }, stream: { append } }),
        },
      },
    });

    expect(snapshot).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
  });
});
