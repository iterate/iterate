import { describe, expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { buildAgentPathForest } from "./agent-path-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

const createdAt = "2026-08-02T10:00:00.000Z";

function agent(path: string): AgentRecord {
  return {
    path,
    summary: { pinned: false },
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: { createdAt, lastWorkAt: createdAt },
  };
}

describe("agent path forest", () => {
  test("derives every prefix without assuming an /agents root", () => {
    const slackAgent = agent("/agents/slack/c123/ts123/subagent");
    const operationsAgent = agent("/operations/releases/check");
    const forest = buildAgentPathForest({
      [slackAgent.path]: slackAgent,
      [operationsAgent.path]: operationsAgent,
    });

    expect(forest.map((node) => node.path)).toEqual(["/agents", "/operations"]);
    expect(forest[0]?.children[0]).toMatchObject({
      path: "/agents/slack",
      aggregateAgentCount: 1,
    });
    expect(forest[0]?.children[0]?.agent).toBeUndefined();
    expect(forest[0]?.children[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      path: slackAgent.path,
      agent: slackAgent,
    });
    expect(forest[1]?.children[0]?.children[0]).toMatchObject({
      path: operationsAgent.path,
      agent: operationsAgent,
    });
  });
});
