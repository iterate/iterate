import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  extractMatchSnippet,
  fileRef,
  fileSearchKey,
  narrowStreamRefToChunk,
  repoFileRef,
  searchMetadata,
  streamEventsRef,
  normalizeCustomSearchKind,
  normalizeSearchExcludeKinds,
  normalizeSearchSource,
  projectSearchInstanceConfig,
  projectSearchInstanceId,
  projectSearchPrefix,
  renderStreamSegmentDocument,
  repoFileSearchKey,
  searchFilters,
  SEARCH_SEGMENT_SIZE,
  segmentForOffset,
  segmentOffsetRange,
  sanitizeSearchDocumentId,
  streamSegmentContext,
  streamSegmentKey,
} from "./search-corpus.ts";

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
  it("uses only term operators on kind — range filters are keyword-lane-blind (live-proven)", () => {
    // No scoping: no filters at all — tenancy is structural (per-project
    // instance), never a query-time concern.
    expect(searchFilters({ projectId: "prj_1" })).toEqual({});
  });

  it("pins one source kind with $eq (binds both hybrid lanes)", () => {
    expect(searchFilters({ projectId: "prj_1", source: "repos" })).toEqual({
      kind: { $eq: "repos" },
    });
  });

  it("excludes kinds with one $nin condition; source wins over exclude", () => {
    expect(searchFilters({ projectId: "prj_1", excludeKinds: ["streams", "files"] })).toEqual({
      kind: { $nin: ["streams", "files"] },
    });
    expect(
      searchFilters({ projectId: "prj_1", source: "decisions", excludeKinds: ["streams"] }),
    ).toEqual({ kind: { $eq: "decisions" } });
  });
});

describe("projectSearchInstanceId / projectSearchInstanceConfig", () => {
  it("derives a 32-char instance id by dropping the prj_ prefix", () => {
    expect(projectSearchInstanceId("prj_f2bdefde5fa64623bb1565056de9999b")).toBe(
      "f2bdefde5fa64623bb1565056de9999b",
    );
    expect(() => projectSearchInstanceId("prj_NOT-VALID!chars")).toThrow(/instance id/);
  });

  it("scopes each instance to its project's slice of the shared bucket", () => {
    const config = projectSearchInstanceConfig({
      bucketName: "os-search-index",
      projectId: "prj_abc123",
    });
    expect(config.source_params.include_items).toEqual(["prj_abc123/**"]);
    expect(config.index_method).toEqual({ vector: true, keyword: true });
    expect(config.custom_metadata.map((f) => f.field_name)).toEqual(["kind", "context", "ref"]);
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

describe("extractMatchSnippet", () => {
  it("centers the snippet on the first query-term match", () => {
    const text = "x ".repeat(400) + "the needle in the haystack sits here" + " y".repeat(400);
    const snippet = extractMatchSnippet(text, "needle haystack", 120);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThanOrEqual(124); // ellipses included
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("falls back to the head when no term matches, and passes short text through", () => {
    expect(extractMatchSnippet("short text", "zzz", 100)).toBe("short text");
    const head = extractMatchSnippet("a ".repeat(200), "zzz", 50);
    expect(head.endsWith("…")).toBe(true);
  });
});

describe("normalizeCustomSearchKind / sanitizeSearchDocumentId", () => {
  it("rejects the reserved platform kinds so index() cannot invade their namespaces", () => {
    for (const kind of ["streams", "files", "repos", "docs", "REPOS"]) {
      expect(() => normalizeCustomSearchKind(kind)).toThrow(/reserved/);
    }
  });

  it("rejects kinds with slashes or spaces (would nest under another kind's folder)", () => {
    expect(() => normalizeCustomSearchKind("repos/config")).toThrow(/no slashes/);
    expect(() => normalizeCustomSearchKind("my notes")).toThrow(/no slashes/);
    expect(() => normalizeCustomSearchKind("")).toThrow();
  });

  it("lowercases valid kinds and keeps ids path-shaped but prefix-safe", () => {
    expect(normalizeCustomSearchKind("Notes")).toBe("notes");
    expect(sanitizeSearchDocumentId("/2026/07/meeting notes.md")).toBe("2026/07/meeting-notes.md");
    expect(sanitizeSearchDocumentId("")).toBe("untitled");
  });
});

describe("normalizeSearchSource / normalizeSearchExcludeKinds", () => {
  it("accepts platform kinds in any case (a query scope, not an index write)", () => {
    expect(normalizeSearchSource("streams")).toBe("streams");
    expect(normalizeSearchSource("Streams")).toBe("streams");
    expect(normalizeSearchSource(" FILES ")).toBe("files");
    expect(normalizeSearchSource("repos")).toBe("repos");
  });

  it("normalizes custom kinds by the same rules index() wrote them under", () => {
    expect(normalizeSearchSource("Decisions")).toBe("decisions");
    expect(() => normalizeSearchSource("my notes")).toThrow(/no slashes/);
  });

  it("rejects docs as a source with a federation pointer, in any case", () => {
    expect(() => normalizeSearchSource("docs")).toThrow(/federated/);
    expect(() => normalizeSearchSource("Docs")).toThrow(/federated/);
  });

  it("normalizes exclude entries so they match stored kinds and the docs gate", () => {
    expect(normalizeSearchExcludeKinds(["Docs", " Decisions", "STREAMS"])).toEqual([
      "docs",
      "decisions",
      "streams",
    ]);
  });
});

describe("ref expressions (search hits lead back to domain objects)", () => {
  it("builds evaluable itx expressions for each corpus kind", () => {
    expect(
      streamEventsRef({ path: "/agents/slack/T1", firstOffset: 101, lastOffset: 200 }),
    ).toEqual([
      "streams",
      ["get", "/agents/slack/T1"],
      ["getEvents", { afterOffset: 100, beforeOffset: 201 }],
    ]);
    expect(fileRef("/reports/q3.pdf")).toEqual(["files", ["get", "/reports/q3.pdf"]]);
    expect(repoFileRef({ repoPath: "/repos/config", filePath: "src/worker.ts" })).toEqual([
      "repos",
      ["get", "/repos/config"],
      ["readFile", { path: "src/worker.ts" }],
    ]);
  });

  it("stores the serialized ref in metadata, omitting only oversized ones", () => {
    const metadata = searchMetadata("files", "File /x", fileRef("/x"));
    expect(JSON.parse(metadata.ref!)).toEqual(["files", ["get", "/x"]]);
    const huge = searchMetadata("files", "File /x", fileRef("/" + "x".repeat(600)));
    expect(huge.ref).toBeUndefined();
    expect(huge.kind).toBe("files");
  });
});

describe("narrowStreamRefToChunk (hits name exact events, not the storage segment)", () => {
  const storedRef = streamEventsRef({ path: "/agents/slack/T1", firstOffset: 1, lastOffset: 100 });

  it("narrows to the events the chunk actually contains", () => {
    // The chunk that comes back for "what is the secret" holds the one message.
    const chunk = renderStreamSegmentDocument({
      events: [
        {
          type: "events.iterate.com/test/user-message-received",
          createdAt: "2026-07-13T00:00:00.000Z",
          path: "/agents/slack/T1",
          payload: { text: "the secret is bananas" },
          offset: 42,
        },
      ],
      segment: 0,
      streamPath: "/agents/slack/T1",
    })!;
    expect(narrowStreamRefToChunk(storedRef, chunk)).toEqual([
      "streams",
      ["get", "/agents/slack/T1"],
      ["getEvents", { afterOffset: 41, beforeOffset: 43 }],
    ]);
  });

  it("spans exactly the chunk's events when it holds several", () => {
    const text = "## a/b (offset 41)\ntext\n## a/b (offset 44)\nmore";
    const narrowed = narrowStreamRefToChunk(storedRef, text);
    expect(narrowed[2]).toEqual(["getEvents", { afterOffset: 40, beforeOffset: 45 }]);
  });

  it("falls back to the stored ref for header-less chunks and non-stream refs", () => {
    expect(narrowStreamRefToChunk(storedRef, "mid-payload json with no headers")).toEqual(
      storedRef,
    );
    expect(narrowStreamRefToChunk(fileRef("/x.pdf"), "## a (offset 9)")).toEqual(fileRef("/x.pdf"));
  });
});
