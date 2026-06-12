// Regression coverage for the recursive child-stream storm: the agent-host
// must never boot an agent on itx context streams. An agent on
// `<agent>/itx/...` creates its own itx context, whose child-stream-created
// events boot more agents, recursively flooding every journal under /agents.

import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import { ensureChildAgentRunner, isItxInfrastructurePath } from "./implementation.ts";

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
  it("boots an agent for real child agent streams", async () => {
    const initialized: string[] = [];
    await ensureChildAgentRunner({
      agentNamespace: fakeAgentNamespace(initialized),
      event: childCreatedEvent("/agents/demo/sub-agent"),
      projectId: "prj_test",
    });
    expect(initialized).toHaveLength(1);
  });

  it("never boots agents on itx context streams", async () => {
    const initialized: string[] = [];
    for (const childPath of [
      "/agents/demo/itx",
      "/agents/demo/itx/itx__os__01ktx8j7scecrsm5wqt2dcg8y5",
      "/agents/demo/itx/itx/itx__os__01ktx8j7vdecrsm5x2tgwvvcjm/itx",
    ]) {
      await ensureChildAgentRunner({
        agentNamespace: fakeAgentNamespace(initialized),
        event: childCreatedEvent(childPath),
        projectId: "prj_test",
      });
    }
    expect(initialized).toEqual([]);
  });
});

describe("isItxInfrastructurePath", () => {
  it("matches any path with an itx segment", () => {
    expect(isItxInfrastructurePath("/agents/demo/itx")).toBe(true);
    expect(isItxInfrastructurePath("/agents/demo/itx/itx__os__abc")).toBe(true);
    expect(isItxInfrastructurePath("/agents/demo")).toBe(false);
    expect(isItxInfrastructurePath("/agents/itx-fan")).toBe(false);
  });
});
