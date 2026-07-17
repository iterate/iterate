import { describe, expect, it, vi } from "vitest";
import {
  MCP_AGENT_SYSTEM_PROMPT,
  MCP_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("waits for zero-argument creation before appending the session policy", async () => {
    const created = Promise.withResolvers<void>();
    const create = vi.fn(() => created.promise);
    const append = vi.fn().mockResolvedValue([]);
    let requestedPath: string | undefined;

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        agents: {
          get(path) {
            requestedPath = path;
            return { append, create };
          },
        },
      },
    });

    await Promise.resolve();

    expect(requestedPath).toBe("/agents/mcp/session-test");
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
      idempotencyKey: `agent/mcp-system-prompt:v${MCP_AGENT_SYSTEM_PROMPT_REVISION}`,
      payload: {
        role: "system",
        key: "agent/system-prompt",
        content: MCP_AGENT_SYSTEM_PROMPT,
      },
    });
  });

  it("retries the same exact policy occurrence after idempotent creation", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue([]);
    const projectItx = {
      agents: {
        get: () => ({ append, create }),
      },
    };

    await ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx,
    });
    await ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]).toEqual(append.mock.calls[0]);
  });
});
