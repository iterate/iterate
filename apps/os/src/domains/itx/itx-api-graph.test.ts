// Unit tests for the Itx Type Graph helpers, run against the REAL generated
// graph — the invariants here (unique names, resolving references, budget
// behavior) are what itx.docs relies on at runtime.
import { describe, expect, test } from "vitest";
import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";
import * as graphHelpers from "./itx-api-graph.ts";
import {
  declarationsByName,
  mountDeclaration,
  referencedPlatformTypeNames,
  searchScore,
  weightedDeclarationScore,
  typeSlice,
} from "./itx-api-graph.ts";

const byName = declarationsByName(ITX_API_DECLARATIONS);

describe("the generated graph", () => {
  test("declaration names are unique and references resolve", () => {
    expect(byName.size).toBe(ITX_API_DECLARATIONS.length);
    const unresolved = ITX_API_DECLARATIONS.flatMap((declaration) =>
      declaration.referencedTypeNames.filter((name) => !byName.has(name)),
    );
    expect(unresolved).toEqual([]);
  });

  test("every declaration has a one-sentence summary", () => {
    // Search results and children maps show summaries; a docless declaration
    // is invisible to the dumb search.
    const docless = ITX_API_DECLARATIONS.filter((d) => d.summary.trim() === "").map((d) => d.name);
    expect(docless).toEqual([]);
  });

  test("the anchor declarations exist", () => {
    for (const name of ["Project", "Agent", "Stream", "Repo", "Workspace", "Docs"]) {
      expect(byName.has(name), `missing declaration "${name}"`).toBe(true);
    }
  });
});

describe("typeSlice", () => {
  test("includes the reference closure in breadth-first order within budget", () => {
    const slice = typeSlice({ declarations: byName, rootName: "Stream", maxTokens: 10_000 });
    expect(slice.includedNames[0]).toBe("Stream");
    expect(slice.includedNames).toContain("StreamEvent");
    expect(slice.frontierNames).toEqual([]);
    expect(slice.sourceText).toContain("export interface Stream");
  });

  test("stops at the budget and names the frontier with a fetch call", () => {
    // Project alone is ~1.4k tokens; 1,600 fits the root but not its closure.
    const slice = typeSlice({ declarations: byName, rootName: "Project", maxTokens: 1_600 });
    expect(slice.includedNames[0]).toBe("Project");
    expect(slice.frontierNames.length).toBeGreaterThan(10);
    expect(slice.sourceText).toContain("// Not included:");
    expect(slice.sourceText).toContain('await itx.docs.get({ name: "');
  });

  test("a root alone over budget is truncated loudly, never dropped", () => {
    const slice = typeSlice({ declarations: byName, rootName: "Project", maxTokens: 50 });
    expect(slice.includedNames).toEqual(["Project"]);
    expect(slice.sourceText).toContain("truncated");
  });

  test("throws on unknown roots", () => {
    expect(() => typeSlice({ declarations: byName, rootName: "Nope", maxTokens: 100 })).toThrow(
      /unknown type declaration/,
    );
  });

  test("is deterministic", () => {
    const a = typeSlice({ declarations: byName, rootName: "Agent", maxTokens: 2_000 });
    const b = typeSlice({ declarations: byName, rootName: "Agent", maxTokens: 2_000 });
    expect(a.sourceText).toBe(b.sourceText);
  });
});

describe("weightedDeclarationScore", () => {
  test("counts name/summary words fully and member-only words half", () => {
    expect(
      weightedDeclarationScore({
        query: "stream append events",
        ownText: "Stream One durable event stream",
        memberText: "append appends events to the stream",
      }),
    ).toBe(2); // "stream" in own text (1), "append" + "events" member-only (0.5 each)
  });

  test("keeps hub declarations from matching wholesale on member text", () => {
    // Every query word landing ONLY in member summaries scores half per
    // word — a hub type no longer beats an example whose title matches.
    expect(
      weightedDeclarationScore({
        query: "send message agent",
        ownText: "Project the root project surface",
        memberText: "agents send message to an agent streams repos",
      }),
    ).toBe(1.5);
  });
});

describe("searchScore", () => {
  test("counts distinct matching words, case-insensitively", () => {
    expect(searchScore("email gmail inbox", "Gmail requests against the INBOX")).toBe(2);
    expect(searchScore("email gmail gmail", "gmail")).toBe(1);
    expect(searchScore("zebra", "no such word")).toBe(0);
  });

  test('drops noise words — "itx.docs" means "docs", not "everything +1"', () => {
    // "itx" substring-matches virtually every haystack; scoring it would give
    // unrelated rows the same score as the row the searcher wants.
    expect(searchScore("itx.docs", "generate an image with itx.ai.run")).toBe(0);
    expect(searchScore("itx.docs", "the docs door: search and get")).toBe(1);
    // An all-noise query still matches noisily instead of returning nothing.
    expect(searchScore("itx", "call anything on itx")).toBe(1);
  });
});

describe("stripComments", () => {
  test("drops comments but leaves string contents — // in a URL is not a comment", () => {
    const { stripComments } = graphHelpers;
    expect(stripComments("// line\ncode; /* block */ more")).toBe("\ncode;  more");
    expect(stripComments('import("openapi:https://x.example/spec.json")')).toBe(
      'import("openapi:https://x.example/spec.json")',
    );
    expect(stripComments('const s = "a // not comment"; // real')).toBe(
      'const s = "a // not comment"; ',
    );
    expect(stripComments('"escaped \\" quote // stays"')).toBe('"escaped \\" quote // stays"');
  });
});

describe("mounted capabilities in the graph", () => {
  test("referencedPlatformTypeNames scans code, not comments or local bindings", () => {
    expect(
      referencedPlatformTypeNames(
        "// Stream in a comment does not count\nexport type Root = { tail(): Promise<StreamEvent[]>; agent: Agent };",
        byName,
      ).sort(),
    ).toEqual(["Agent", "StreamEvent"]);
    expect(referencedPlatformTypeNames("export type X = { n: number };", byName)).toEqual([]);
    // Names the text binds itself — declarations of any kind, or import
    // bindings — shadow the platform ones.
    expect(referencedPlatformTypeNames("export declare class Agent { x: Stream }", byName)).toEqual(
      ["Stream"],
    );
    expect(
      referencedPlatformTypeNames(
        'import type { Stream } from "vendor";\nexport type X = Stream;',
        byName,
      ),
    ).toEqual([]);
  });

  test("a typed mount slices across the layer boundary into platform declarations", () => {
    const synthetic = mountDeclaration({
      declarations: byName,
      dottedPath: "tools.tail",
      instructions: "The project stream's newest events. Call tools.tail.tail().",
      types: "export type Tail = { tail(): Promise<StreamEvent[]> };",
    });
    const declarations = new Map(byName);
    declarations.set(synthetic.name, synthetic);
    const slice = typeSlice({ declarations, rootName: "tools.tail", maxTokens: 4_000 });
    expect(slice.includedNames[0]).toBe("tools.tail");
    expect(slice.includedNames).toContain("StreamEvent");
    expect(slice.sourceText).toContain('Mounted capability "tools.tail"');
    // FULL instructions ride the entry, not just the first sentence.
    expect(slice.sourceText).toContain("Call tools.tail.tail().");
  });

  test("an untyped mount still yields a readable entry", () => {
    const synthetic = mountDeclaration({
      declarations: byName,
      dottedPath: "legacy",
      instructions: "An old mount.",
    });
    expect(synthetic.referencedTypeNames).toEqual([]);
    expect(synthetic.sourceText).toContain("No types recorded");
    expect(synthetic.sourceText).toContain("itx.legacy.__describe()");
  });
});
