import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  fileSearchKey,
  projectSearchPrefix,
  renderStreamSegmentDocument,
  repoFileSearchKey,
  searchFilters,
  SEARCH_SEGMENT_SIZE,
  segmentForOffset,
  segmentOffsetRange,
  shouldIndexStreamPath,
  streamSegmentContext,
  streamSegmentKey,
} from "./search-index.ts";

function event(overrides: Partial<StreamEvent> & { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/agent/message-received",
    createdAt: "2026-07-08T00:00:00.000Z",
    path: "/agents/slack/T1/thr-9",
    payload: { text: "hello world" },
    ...overrides,
  };
}

describe("segment math", () => {
  it("maps offsets to fixed segments (offset 1 → segment 0)", () => {
    expect(segmentForOffset(1)).toBe(0);
    expect(segmentForOffset(SEARCH_SEGMENT_SIZE)).toBe(0);
    expect(segmentForOffset(SEARCH_SEGMENT_SIZE + 1)).toBe(1);
    expect(segmentForOffset(250)).toBe(2);
  });

  it("segment bounds are inclusive and adjacent segments do not overlap", () => {
    expect(segmentOffsetRange(0)).toEqual({ first: 1, last: SEARCH_SEGMENT_SIZE });
    expect(segmentOffsetRange(2)).toEqual({ first: 201, last: 300 });
    // Every offset belongs to exactly the segment whose range contains it.
    for (const offset of [1, 99, 100, 101, 200, 201]) {
      const { first, last } = segmentOffsetRange(segmentForOffset(offset));
      expect(offset).toBeGreaterThanOrEqual(first);
      expect(offset).toBeLessThanOrEqual(last);
    }
  });
});

describe("index keys", () => {
  it("prefixes every key with the owning project id", () => {
    expect(
      streamSegmentKey({ projectId: "prj_1", streamPath: "/agents/slack/T1", segment: 3 }),
    ).toBe("prj_1/streams/agents/slack/T1/events-00000003.md");
    expect(fileSearchKey({ projectId: "prj_1", path: "/notes/report.pdf" })).toBe(
      "prj_1/files/notes/report.pdf",
    );
    expect(
      repoFileSearchKey({ projectId: "prj_1", repoPath: "/repo", filePath: "src/index.ts" }),
    ).toBe("prj_1/repos/repo/files/src/index.ts");
  });

  it("keys sort under the project prefix the folder filter scopes to", () => {
    const prefix = projectSearchPrefix("prj_1");
    for (const key of [
      streamSegmentKey({ projectId: "prj_1", streamPath: "/a", segment: 0 }),
      fileSearchKey({ projectId: "prj_1", path: "/f.txt" }),
      repoFileSearchKey({ projectId: "prj_1", repoPath: "/repo", filePath: "a.ts" }),
    ]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
    // A different project id never lands inside the range.
    expect("prj_2/files/f.txt".startsWith(prefix)).toBe(false);
  });
});

describe("searchFilters", () => {
  it("builds the documented lexicographic folder prefix range", () => {
    const filter = searchFilters({ projectId: "prj_1" });
    expect(filter.type).toBe("and");
    const [gte, lt] = filter.filters;
    expect(gte).toMatchObject({ type: "gte", key: "folder", value: "prj_1/" });
    expect(lt?.type).toBe("lt");
    // Every folder under the project sorts inside [gte, lt); the next
    // project id sorts outside it.
    expect("prj_1/streams/a/" >= String(gte?.value)).toBe(true);
    expect("prj_1/streams/a/" < String(lt?.value)).toBe(true);
    expect("prj_2/" < String(lt?.value) && "prj_2/" >= String(gte?.value)).toBe(false);
  });

  it("narrows to one source kind via the folder prefix", () => {
    const filter = searchFilters({ projectId: "prj_1", source: "repos" });
    expect(filter.filters[0]?.value).toBe("prj_1/repos");
  });

  it("adds a `kind != x` condition per excluded kind (flat AND)", () => {
    const filter = searchFilters({ projectId: "prj_1", excludeKinds: ["streams", "files"] });
    const ne = filter.filters.filter((f) => f.type === "ne");
    expect(ne).toEqual([
      { type: "ne", key: "kind", value: "streams" },
      { type: "ne", key: "kind", value: "files" },
    ]);
  });
});

describe("shouldIndexStreamPath (index-time selectivity)", () => {
  it("never indexes secrets or the integration webhook firehoses", () => {
    expect(shouldIndexStreamPath("/secrets/integrations/github/install-1/token")).toBe(false);
    expect(shouldIndexStreamPath("/secrets")).toBe(false);
    expect(shouldIndexStreamPath("/integrations/github/install-115079265")).toBe(false);
    expect(shouldIndexStreamPath("/integrations")).toBe(false);
  });

  it("indexes ordinary content streams (agents, repos)", () => {
    expect(shouldIndexStreamPath("/agents/slack/T1/thr-9")).toBe(true);
    expect(shouldIndexStreamPath("/repos/config")).toBe(true);
    expect(shouldIndexStreamPath("/")).toBe(true);
    // A path that merely CONTAINS the word is fine — only the prefix matters.
    expect(shouldIndexStreamPath("/agents/secrets-helper")).toBe(true);
  });
});

describe("streamSegmentContext", () => {
  it("describes the segment's stream and offset window for result provenance", () => {
    expect(streamSegmentContext({ streamPath: "/agents/slack/T1", segment: 1 })).toBe(
      "Stream /agents/slack/T1 — events 101–200",
    );
  });
});

describe("renderStreamSegmentDocument", () => {
  it("renders indexable events with type, offset, and payload", () => {
    const document = renderStreamSegmentDocument({
      events: [event({ offset: 101 }), event({ offset: 102, payload: { text: "again" } })],
      segment: 1,
      streamPath: "/agents/slack/T1/thr-9",
    });
    expect(document).toContain("# Stream /agents/slack/T1/thr-9 — events 101–200");
    expect(document).toContain("events.iterate.com/agent/message-received (offset 101)");
    expect(document).toContain('"text": "hello world"');
    expect(document).toContain('"text": "again"');
  });

  it("drops disallow-listed housekeeping events and returns null when nothing remains", () => {
    const woken = event({ offset: 1, type: "events.iterate.com/stream/woken" });
    expect(
      renderStreamSegmentDocument({ events: [woken], segment: 0, streamPath: "/x" }),
    ).toBeNull();
    const document = renderStreamSegmentDocument({
      events: [woken, event({ offset: 2 })],
      segment: 0,
      streamPath: "/x",
    });
    expect(document).not.toContain("stream/woken");
    expect(document).toContain("offset 2");
  });

  it("truncates oversized payloads instead of growing past the document cap", () => {
    const document = renderStreamSegmentDocument({
      events: [event({ offset: 3, payload: { blob: "x".repeat(50_000) } })],
      segment: 0,
      streamPath: "/x",
    });
    expect(document).toContain("… (truncated)");
    expect(document!.length).toBeLessThan(20_000);
  });
});
