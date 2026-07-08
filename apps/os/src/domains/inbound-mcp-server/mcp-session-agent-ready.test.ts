import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import {
  ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS,
  ensureMcpSessionAgentReady,
} from "./mcp-session-agent-ready.ts";

describe("ensureMcpSessionAgentReady", () => {
  it("creates the session stream and waits for the agent system prompt before returning", async () => {
    const promptReady = Promise.withResolvers<StreamEvent>();
    const appended: StreamEventInput[] = [];
    const waitCalls: Array<{
      afterOffset?: number;
      eventTypes?: readonly string[];
      timeoutMs: number;
    }> = [];
    let requestedPath: string | undefined;

    const ready = ensureMcpSessionAgentReady({
      agentPath: "/agents/mcp/session-test",
      projectItx: {
        streams: {
          get(path) {
            requestedPath = path;
            return {
              async append(...events) {
                appended.push(...events);
                return events.map((event, index) => ({
                  ...event,
                  createdAt: new Date(index + 1).toISOString(),
                  offset: index + 1,
                  path,
                }));
              },
              async waitForEvent(args) {
                waitCalls.push(args);
                return await promptReady.promise;
              },
            };
          },
        },
      },
    });

    await Promise.resolve();

    expect(requestedPath).toBe("/agents/mcp/session-test");
    expect(appended).toEqual([
      {
        type: "events.iterate.com/mcp/session-agent-warmup",
        idempotencyKey: "mcp/session-agent-warmup:/agents/mcp/session-test",
        payload: { agentPath: "/agents/mcp/session-test" },
      },
    ]);
    expect(waitCalls).toEqual([
      {
        afterOffset: 0,
        eventTypes: ["events.iterate.com/agent/system-prompt-updated"],
        timeoutMs: ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS,
      },
    ]);

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
