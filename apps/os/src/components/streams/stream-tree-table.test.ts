import { describe, expect, test } from "vitest";
import {
  buildIndexedStreamForest,
  buildRemoteStreamForest,
  formatEventCount,
  streamTreeLabel,
} from "./stream-tree-table.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";

const createdAt = "2026-07-17T10:00:00.000Z";

function stream(path: string, eventCount = 1): StreamIndexRow {
  return {
    path,
    createdAt,
    lastActivityAt: createdAt,
    lastType: "events.iterate.com/test",
    eventCount,
  };
}

describe("stream tree table model", () => {
  test("uses the closest indexed stream ancestor without inventing path nodes", () => {
    const rows = [stream("/"), stream("/agents"), stream("/agents/a/deep")];
    const [root] = buildIndexedStreamForest(Object.fromEntries(rows.map((row) => [row.path, row])));

    expect(root?.path).toBe("/");
    expect(root?.children[0]?.path).toBe("/agents");
    expect(root?.children[0]?.children[0]?.path).toBe("/agents/a/deep");
    expect(root?.children[0]?.children[0]?.eventCount).toBe(1);
  });

  test("honors remote child links while representing pending and failed rows", () => {
    const [root] = buildRemoteStreamForest([
      {
        path: "/",
        loadState: "loaded",
        data: { eventCount: 9, childPaths: ["/agents", "/global"] },
      },
      {
        path: "/agents",
        loadState: "loaded",
        data: { eventCount: 4, childPaths: ["/agents/slack/thread"] },
      },
      { path: "/global", loadState: "error" },
    ]);

    expect(root).toMatchObject({ path: "/", eventCount: 9, loadState: "loaded" });
    expect(root?.children.map((node) => node.path)).toEqual(["/agents", "/global"]);
    expect(root?.children[0]?.children[0]).toMatchObject({
      path: "/agents/slack/thread",
      loadState: "loading",
    });
    expect(root?.children[1]).toMatchObject({ path: "/global", loadState: "error" });
  });

  test("derives remote parents from paths even when child links are malformed", () => {
    const [root] = buildRemoteStreamForest([
      {
        path: "/",
        loadState: "loaded",
        data: { eventCount: 2, childPaths: ["/agents"] },
      },
      {
        path: "/agents",
        loadState: "loaded",
        data: { eventCount: 1, childPaths: ["/"] },
      },
    ]);

    expect(root?.path).toBe("/");
    expect(root?.children.map((node) => node.path)).toEqual(["/agents"]);
  });

  test("labels leaf paths and formats event counts", () => {
    expect(streamTreeLabel("/")).toBe("/");
    expect(streamTreeLabel("/agents/repos/config")).toBe("config");
    expect(formatEventCount(1)).toBe("1 event");
    expect(formatEventCount(827)).toBe("827 events");
  });
});
