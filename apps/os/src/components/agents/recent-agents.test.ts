import { describe, expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { RECENTLY_ACTIVE_AGENTS_LIMIT, selectRecentlyActiveAgents } from "./recent-agents.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

const createdAt = "2026-07-17T10:00:00.000Z";

function agent(path: string, lastWorkAt: string): AgentRecord {
  return {
    path,
    summary: { pinned: false },
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: { createdAt, lastWorkAt },
  };
}

describe("selectRecentlyActiveAgents", () => {
  test("orders by lastWorkAt descending, then path", () => {
    const agents = {
      "/agents/old": agent("/agents/old", "2026-07-17T10:01:00.000Z"),
      "/agents/mid": agent("/agents/mid", "2026-07-17T10:02:00.000Z"),
      "/agents/new": agent("/agents/new", "2026-07-17T10:03:00.000Z"),
    };

    expect(selectRecentlyActiveAgents(agents).map((a) => a.path)).toEqual([
      "/agents/new",
      "/agents/mid",
      "/agents/old",
    ]);
  });

  test("breaks lastWorkAt ties by path ascending", () => {
    const same = "2026-07-17T10:00:00.000Z";
    const agents = {
      "/agents/zebra": agent("/agents/zebra", same),
      "/agents/alpha": agent("/agents/alpha", same),
    };
    expect(selectRecentlyActiveAgents(agents).map((a) => a.path)).toEqual([
      "/agents/alpha",
      "/agents/zebra",
    ]);
  });

  test("caps the excerpt at the dashboard limit (8)", () => {
    const agents = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => {
        const path = `/agents/a${String(i).padStart(2, "0")}`;
        const lastWorkAt = new Date(Date.parse(createdAt) + i * 1000).toISOString();
        return [path, agent(path, lastWorkAt)];
      }),
    );

    const selected = selectRecentlyActiveAgents(agents);
    expect(selected).toHaveLength(RECENTLY_ACTIVE_AGENTS_LIMIT);
    expect(RECENTLY_ACTIVE_AGENTS_LIMIT).toBe(8);
    // Newest of the 12 is a11; excerpt is a11 … a04
    expect(selected.map((a) => a.path)).toEqual([
      "/agents/a11",
      "/agents/a10",
      "/agents/a09",
      "/agents/a08",
      "/agents/a07",
      "/agents/a06",
      "/agents/a05",
      "/agents/a04",
    ]);
  });

  test("honors a smaller explicit limit", () => {
    const agents = {
      "/agents/a": agent("/agents/a", "2026-07-17T10:03:00.000Z"),
      "/agents/b": agent("/agents/b", "2026-07-17T10:02:00.000Z"),
      "/agents/c": agent("/agents/c", "2026-07-17T10:01:00.000Z"),
    };
    expect(selectRecentlyActiveAgents(agents, 2).map((a) => a.path)).toEqual([
      "/agents/a",
      "/agents/b",
    ]);
  });

  test("returns empty for an empty map or non-positive limit", () => {
    expect(selectRecentlyActiveAgents({})).toEqual([]);
    expect(selectRecentlyActiveAgents({ "/agents/a": agent("/agents/a", createdAt) }, 0)).toEqual(
      [],
    );
  });
});
