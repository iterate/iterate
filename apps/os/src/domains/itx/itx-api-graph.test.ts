// Unit tests for the Itx Type Graph helpers, run against the REAL generated
// graph — the invariants here (unique names, resolving references, budget
// behavior) are what itx.docs relies on at runtime.
import { describe, expect, test } from "vitest";
import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";
import { declarationsByName, searchScore, typeSlice } from "./itx-api-graph.ts";

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

describe("searchScore", () => {
  test("counts distinct matching words, case-insensitively", () => {
    expect(searchScore("email gmail inbox", "Gmail requests against the INBOX")).toBe(2);
    expect(searchScore("email gmail gmail", "gmail")).toBe(1);
    expect(searchScore("zebra", "no such word")).toBe(0);
  });
});
