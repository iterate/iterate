import { describe, expect, test } from "vitest";
import {
  buildIndexedStreamForest,
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
  test("infers every path container around indexed streams", () => {
    const rows = [stream("/agents/slack/c123/ts12313/child"), stream("/outside/worker", 3)];
    const [root] = buildIndexedStreamForest(Object.fromEntries(rows.map((row) => [row.path, row])));

    expect(root).toMatchObject({ path: "/" });
    expect(root?.indexRow).toBeUndefined();
    expect(root?.children.map((node) => node.path)).toEqual(["/agents", "/outside"]);

    const agents = root?.children[0];
    expect(agents).toMatchObject({ path: "/agents" });
    expect(agents?.indexRow).toBeUndefined();
    expect(agents?.children[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      path: "/agents/slack/c123/ts12313/child",
      indexRow: expect.objectContaining({ eventCount: 1 }),
    });
    expect(root?.children[1]?.children[0]).toMatchObject({
      path: "/outside/worker",
      indexRow: expect.objectContaining({ eventCount: 3 }),
    });
  });

  test("keeps index data when an inferred container is also a stream", () => {
    const rows = [stream("/agents", 2), stream("/agents/a/deep", 4)];
    const [root] = buildIndexedStreamForest(Object.fromEntries(rows.map((row) => [row.path, row])));

    expect(root).toMatchObject({ path: "/" });
    expect(root?.children[0]).toMatchObject({
      path: "/agents",
      indexRow: expect.objectContaining({ eventCount: 2 }),
    });
    expect(root?.children[0]?.children[0]).toMatchObject({ path: "/agents/a" });
    expect(root?.children[0]?.children[0]?.indexRow).toBeUndefined();
    expect(root?.children[0]?.children[0]?.children[0]).toMatchObject({
      path: "/agents/a/deep",
      indexRow: expect.objectContaining({ eventCount: 4 }),
    });
  });

  test("keeps unusual indexed paths in the tree without crashing every surface", () => {
    const rows = [stream("/a/b/", 2), stream("/a//c", 3)];
    const forest = buildIndexedStreamForest(Object.fromEntries(rows.map((row) => [row.path, row])));
    const byPath = new Map<string, ReturnType<typeof buildIndexedStreamForest>[number]>();
    const visit = (nodes: ReturnType<typeof buildIndexedStreamForest>) => {
      for (const node of nodes) {
        byPath.set(node.path, node);
        visit(node.children);
      }
    };
    visit(forest);

    expect(byPath.get("/a/b/")?.indexRow).toMatchObject({ eventCount: 2 });
    expect(byPath.get("/a//c")?.indexRow).toMatchObject({ eventCount: 3 });
  });

  test("labels leaf paths and formats event counts", () => {
    expect(streamTreeLabel("/")).toBe("/");
    expect(streamTreeLabel("/agents/repos/config")).toBe("config");
    expect(formatEventCount(1)).toBe("1 event");
    expect(formatEventCount(827)).toBe("827 events");
  });
});
