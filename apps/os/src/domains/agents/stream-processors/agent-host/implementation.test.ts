// The agent-host boots an agent for every child stream of an agent — child
// streams under /agents are agents (or sub-agents) by definition since #1510
// moved itx contexts off the agent subtree (an agent's context IS its own
// stream; anonymous extensions live under the project-root /itx).

import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import { ensureChildAgentRunner } from "./implementation.ts";

function childCreatedEvent(childPath: string): Event {
  return {
    type: "events.iterate.com/stream/child-stream-created",
    payload: { childPath },
    offset: 1,
    createdAt: "2026-06-12T00:00:00.000Z",
    streamPath: "/agents/demo",
  } as unknown as Event;
}

function fakeAgentNamespace(initialized: string[]) {
  return {
    getByName: (name: string) => ({
      initialize: async () => {
        initialized.push(name);
      },
    }),
  } as never;
}

describe("agent-host child agent booting", () => {
  it("boots an agent for child agent streams", async () => {
    const initialized: string[] = [];
    for (const childPath of ["/agents/demo/sub-agent", "/agents/itx"]) {
      await ensureChildAgentRunner({
        agentNamespace: fakeAgentNamespace(initialized),
        event: childCreatedEvent(childPath),
        projectId: "prj_test",
      });
    }
    expect(initialized).toHaveLength(2);
  });
});
