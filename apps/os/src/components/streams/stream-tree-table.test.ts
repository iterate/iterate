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

    expect(root).toMatchObject({ path: "/", indexed: false });
    expect(root?.eventCount).toBeUndefined();
    expect(root?.children.map((node) => node.path)).toEqual(["/agents", "/outside"]);

    const agents = root?.children[0];
    expect(agents).toMatchObject({ path: "/agents", indexed: false });
    expect(agents?.children[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      path: "/agents/slack/c123/ts12313/child",
      indexed: true,
      eventCount: 1,
    });
    expect(root?.children[1]?.children[0]).toMatchObject({
      path: "/outside/worker",
      indexed: true,
      eventCount: 3,
    });
  });

  test("keeps index data when an inferred container is also a stream", () => {
    const rows = [stream("/agents", 2), stream("/agents/a/deep", 4)];
    const [root] = buildIndexedStreamForest(Object.fromEntries(rows.map((row) => [row.path, row])));

    expect(root).toMatchObject({ path: "/", indexed: false });
    expect(root?.children[0]).toMatchObject({ path: "/agents", indexed: true, eventCount: 2 });
    expect(root?.children[0]?.children[0]).toMatchObject({
      path: "/agents/a",
      indexed: false,
    });
    expect(root?.children[0]?.children[0]?.children[0]).toMatchObject({
      path: "/agents/a/deep",
      indexed: true,
      eventCount: 4,
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

    expect(byPath.get("/a/b/")).toMatchObject({ indexed: true, eventCount: 2 });
    expect(byPath.get("/a//c")).toMatchObject({ indexed: true, eventCount: 3 });
  });

  test("labels leaf paths and formats event counts", () => {
    expect(streamTreeLabel("/")).toBe("/");
    expect(streamTreeLabel("/agents/repos/config")).toBe("config");
    expect(formatEventCount(1)).toBe("1 event");
    expect(formatEventCount(827)).toBe("827 events");
  });
});
