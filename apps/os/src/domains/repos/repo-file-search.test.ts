import { describe, expect, test } from "vitest";
import { parseSearchRepoFilesInput, searchRepoFilePaths } from "./repo-file-search.ts";

const paths = [
  "worker.ts",
  "AGENTS.md",
  "src/components/agent-pill-composer.tsx",
  "src/routes/agents.tsx",
];

describe("searchRepoFilePaths", () => {
  test("ranks direct path matches before fuzzy subsequences", () => {
    expect(searchRepoFilePaths(paths, { query: "agent" })).toEqual([
      "AGENTS.md",
      "src/routes/agents.tsx",
      "src/components/agent-pill-composer.tsx",
    ]);
    expect(searchRepoFilePaths(paths, { query: "apc" })).toEqual([
      "src/components/agent-pill-composer.tsx",
    ]);
  });

  test("returns a bounded alphabetical list for an empty query", () => {
    expect(searchRepoFilePaths(paths, { query: "", limit: 2 })).toEqual([
      "AGENTS.md",
      "src/components/agent-pill-composer.tsx",
    ]);
  });
});

describe("parseSearchRepoFilesInput", () => {
  test("rejects unbounded or malformed public inputs", () => {
    expect(() => parseSearchRepoFilesInput({ query: "x", limit: 0 })).toThrow(/integer from 1/);
    expect(() => parseSearchRepoFilesInput({ query: "x".repeat(257) })).toThrow(/at most 256/);
  });
});
