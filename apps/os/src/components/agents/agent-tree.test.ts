import { describe, expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { serialize } from "capnweb";
import { buildAgentForest, flattenVisibleAgentRows, pinnedAgentShortcuts } from "./agent-tree.ts";
import {
  AGENT_ACTIVITY_MAX_LENGTH,
  AGENT_BINDING_CONNECTION_MAX_LENGTH,
  AGENT_BINDING_ID_MAX_LENGTH,
  AGENT_BINDING_LABEL_MAX_LENGTH,
  AGENT_BINDING_URL_MAX_LENGTH,
  AGENT_PATH_MAX_LENGTH,
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  AgentRecord,
} from "~/domains/agents/agent-presence.ts";

const createdAt = "2026-07-17T10:00:00.000Z";

function agent(path: string, input: Partial<AgentRecord> = {}): AgentRecord {
  return {
    path,
    summary: { pinned: false },
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: { createdAt, lastWorkAt: createdAt },
    ...input,
  };
}

describe("agent forest", () => {
  test("uses the closest existing agent ancestor without inventing intermediate agents", () => {
    const records = Object.fromEntries(
      [
        agent("/agents/research"),
        agent("/agents/research/farms/pricing"),
        agent("/agents/research/farms/pricing/retail"),
      ].map((record) => [record.path, record]),
    );
    const [root] = buildAgentForest(records);

    expect(root?.children.map((node) => node.agent.path)).toEqual([
      "/agents/research/farms/pricing",
    ]);
    expect(root?.children[0]?.children[0]?.agent.path).toBe(
      "/agents/research/farms/pricing/retail",
    );
  });

  test("aggregates descendant runtime, waits, counts, and latest work", () => {
    const records = Object.fromEntries(
      [
        agent("/agents/root", { summary: { pinned: false, waitingFor: "user_input" } }),
        agent("/agents/root/child", {
          runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 2 },
          timestamps: { createdAt, lastWorkAt: "2026-07-17T11:00:00.000Z" },
        }),
      ].map((record) => [record.path, record]),
    );
    const [root] = buildAgentForest(records);

    expect(root).toMatchObject({
      aggregateRuntime: { runningScripts: 2 },
      aggregateWaiting: { userInput: 1 },
      aggregateLastWorkAt: "2026-07-17T11:00:00.000Z",
      aggregateAgentCount: 2,
      aggregateActiveCount: 1,
    });
  });

  test("keeps pinned children in the forest and also returns flat shortcuts", () => {
    const child = agent("/agents/root/child", { summary: { pinned: true } });
    const records = {
      "/agents/root": agent("/agents/root"),
      [child.path]: child,
    };
    const forest = buildAgentForest(records);

    expect(forest[0]?.children[0]?.agent.path).toBe(child.path);
    expect(pinnedAgentShortcuts(forest).map((node) => node.agent.path)).toEqual([child.path]);
  });

  test("search retains ancestors and reveals matching descendants", () => {
    const records = {
      "/agents/root": agent("/agents/root", { summary: { pinned: false, title: "Parent" } }),
      "/agents/root/child": agent("/agents/root/child", {
        summary: { pinned: false, activity: "Researching cows near Bath" },
      }),
      "/agents/other": agent("/agents/other", { summary: { pinned: false, title: "Other" } }),
    };
    const rows = flattenVisibleAgentRows(buildAgentForest(records), new Set(), "cows");

    expect(rows.map((row) => [row.node.agent.path, row.expanded])).toEqual([
      ["/agents/root", true],
      ["/agents/root/child", true],
    ]);
  });

  test("reparents descendants when a closer agent appears later", () => {
    const child = agent("/agents/root/branch/child");
    expect(buildAgentForest({ [child.path]: child })[0]?.agent.path).toBe(child.path);

    const rebuilt = buildAgentForest({
      "/agents/root": agent("/agents/root"),
      "/agents/root/branch": agent("/agents/root/branch"),
      [child.path]: child,
    });
    expect(rebuilt[0]?.children[0]?.children[0]?.agent.path).toBe(child.path);
  });

  test("sorts equal-priority, equal-time agents deterministically by path", () => {
    const forest = buildAgentForest({
      "/agents/zebra": agent("/agents/zebra"),
      "/agents/alpha": agent("/agents/alpha"),
      "/agents/middle": agent("/agents/middle"),
    });
    expect(forest.map((node) => node.agent.path)).toEqual([
      "/agents/alpha",
      "/agents/middle",
      "/agents/zebra",
    ]);
  });

  test("keeps a maximal 5,000-agent Cap'n Web snapshot below the 16 MiB frame limit", () => {
    const records = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => {
        const prefix = `/agents/load-${String(index).padStart(4, "0")}/`;
        const path = prefix + "p".repeat(AGENT_PATH_MAX_LENGTH - prefix.length);
        const urlPrefix = "https://example.com/";
        const record = AgentRecord.parse(
          agent(path, {
            summary: {
              pinned: index < 5,
              title: "t".repeat(AGENT_TITLE_MAX_LENGTH),
              activity: "a".repeat(AGENT_ACTIVITY_MAX_LENGTH),
              summary: "s".repeat(AGENT_SUMMARY_MAX_LENGTH),
            },
            binding: {
              type: "slack_thread",
              connection: "c".repeat(AGENT_BINDING_CONNECTION_MAX_LENGTH),
              channelId: "i".repeat(AGENT_BINDING_ID_MAX_LENGTH),
              threadTs: "j".repeat(AGENT_BINDING_ID_MAX_LENGTH),
              channelName: "n".repeat(AGENT_BINDING_LABEL_MAX_LENGTH),
              url: urlPrefix + "u".repeat(AGENT_BINDING_URL_MAX_LENGTH - urlPrefix.length),
            },
            timestamps: {
              createdAt,
              lastWorkAt: createdAt,
              summaryUpdatedAt: createdAt,
              activityUpdatedAt: createdAt,
              runtimeUpdatedAt: createdAt,
            },
          }),
        );
        return [path, record];
      }),
    );
    const forest = buildAgentForest(records);

    expect(forest).toHaveLength(5_000);
    expect(flattenVisibleAgentRows(forest, new Set())).toHaveLength(5_000);
    // This is Cap'n Web's actual value serialization, not a plain JSON-size
    // proxy. Include the live-state property envelope the browser receives.
    expect(new TextEncoder().encode(serialize({ agents: records })).byteLength).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });
});
