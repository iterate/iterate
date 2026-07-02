// QUARANTINED (itx-v4 cutover, Phase 10): origin packages/iterate/src/stream-tui/stream-tree.test.ts.
// Part of the legacy stream-browser TUI built on the old engine's /api/itx/run
// client; superseded by the agent chat TUI in src/stream-tui/. See ../README.md.

import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getDefaultExpandedStreamPaths,
  getStreamTreeRows,
  rankStreamPaths,
} from "./stream-tree.ts";
import type { StreamSummary } from "./command-router.ts";

const streams: StreamSummary[] = [
  { path: StreamPath.parse("/agents"), createdAt: "2026-04-29T10:00:00.000Z" },
  { path: StreamPath.parse("/agents/demo"), createdAt: "2026-04-29T10:01:00.000Z" },
  { path: StreamPath.parse("/agents/demo/runs"), createdAt: "2026-04-29T10:02:00.000Z" },
  { path: StreamPath.parse("/agents/prod"), createdAt: "2026-04-29T10:03:00.000Z" },
  { path: StreamPath.parse("/events"), createdAt: "2026-04-29T10:04:00.000Z" },
];

describe("getDefaultExpandedStreamPaths", () => {
  test("expands root, ancestors, and the current stream", () => {
    expect([...getDefaultExpandedStreamPaths(StreamPath.parse("/agents/demo/runs"))]).toEqual([
      "/",
      "/agents",
      "/agents/demo",
      "/agents/demo/runs",
    ]);
  });
});

describe("getStreamTreeRows", () => {
  test("renders a collapsed tree with the current stream path expanded", () => {
    expect(
      getStreamTreeRows({
        streams,
        currentStreamPath: StreamPath.parse("/agents/demo"),
        expandedPaths: new Set(),
        searchQuery: "",
        selectedPath: StreamPath.parse("/agents/demo"),
      }).map((row) => ({
        path: row.path,
        depth: row.depth,
        current: row.current,
        selected: row.selected,
      })),
    ).toEqual([
      { path: "/", depth: 0, current: false, selected: false },
      { path: "/agents", depth: 1, current: false, selected: false },
      { path: "/agents/demo", depth: 2, current: true, selected: true },
      { path: "/agents/demo/runs", depth: 3, current: false, selected: false },
      { path: "/agents/prod", depth: 2, current: false, selected: false },
      { path: "/events", depth: 1, current: false, selected: false },
    ]);
  });

  test("fuzzy search keeps matching branches expanded in place", () => {
    expect(
      getStreamTreeRows({
        streams,
        currentStreamPath: StreamPath.parse("/events"),
        expandedPaths: new Set(),
        searchQuery: "pd",
        selectedPath: StreamPath.parse("/agents/prod"),
      }).map((row) => ({
        path: row.path,
        matched: row.labelSegments
          .filter((segment) => segment.matched)
          .map((segment) => segment.text),
      })),
    ).toEqual([
      { path: "/", matched: [] },
      { path: "/agents", matched: [] },
      { path: "/agents/prod", matched: ["p", "d"] },
    ]);
  });
});

describe("rankStreamPaths", () => {
  test("prefers segment prefixes over loose fuzzy matches", () => {
    expect(
      rankStreamPaths({
        paths: streams.map((stream) => stream.path),
        query: "pro",
      }).map((result) => result.path),
    ).toEqual(["/agents/prod"]);
  });
});
