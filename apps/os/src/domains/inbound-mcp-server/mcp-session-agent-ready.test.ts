import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("creates the session stream and waits for the agent system prompt before returning", async () => {
    const promptReady = Promise.withResolvers<StreamEvent>();

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        streams: {
          get() {
            return {
              async append() {
                return undefined;
              },
              async waitForEvent() {
                return await promptReady.promise;
              },
            };
          },
        },
      },
    });

    await Promise.resolve();

    let returned = false;
    void ready.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    promptReady.resolve({
      type: "events.iterate.com/agent/system-prompt-updated",
      payload: { systemPrompt: "ready" },
      createdAt: new Date().toISOString(),
      offset: 2,
      path: "/agents/mcp/session-test",
    });
    await ready;

    expect(returned).toBe(true);
  });
});
