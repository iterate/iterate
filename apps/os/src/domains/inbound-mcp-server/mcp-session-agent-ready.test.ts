import { describe, expect, it, vi } from "vitest";
import { parsePromptSections } from "iterate/processors";
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
    // The MCP prompt is the tagged default file plus an untagged override
    // suffix: one keyed event per section (the suffix under the fallback
    // key), all in a single atomic append call.
    expect(append).toHaveBeenCalledWith(
      ...parsePromptSections({
        content: MCP_AGENT_SYSTEM_PROMPT,
        fallbackKey: "agent/system-prompt",
      }).map((section, index) => ({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `agent/mcp-system-prompt:v2:v${MCP_AGENT_SYSTEM_PROMPT_REVISION}:${index}:${section.key}`,
        payload: {
          kind: "section",
          key: section.key,
          content: section.content,
          actor: { type: "platform" },
          // The processor ignores the defaulted policy; sections never trigger.
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      })),
    );
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
