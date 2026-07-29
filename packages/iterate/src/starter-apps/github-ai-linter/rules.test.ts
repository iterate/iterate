import { expect, test } from "vitest";
import { loadGithubAiLinterRules } from "./rules.ts";

test("the linter reads only configured rule files", async () => {
  const calls: Array<{ method: string; value: string }> = [];
  const repo = {
    readFile: async ({ path }: { path: string }) => {
      calls.push({ method: "readFile", value: path });
      return {
        commitOid: "abc123",
        path,
        content: [
          "---",
          "id: typescript/no-inferable-type-annotation",
          "files:",
          "  [",
          '    "**/*.{ts,tsx,mts,cts}",',
          '    "!**/*.test.ts",',
          "  ]",
          "---",
          "# Do not annotate inferable types",
          "",
          "Do not declare a type annotation that TypeScript can infer from the value.",
        ].join("\n"),
      };
    },
  };
  const itx = { repos: { get: (path: string) => (path === "/repos/iterate" ? repo : null) } };

  const rules = await loadGithubAiLinterRules(itx as any, {
    paths: ["rules/typescript/no-inferable-type-annotation.md"],
    repoPath: "/repos/iterate",
  });

  expect(calls).toEqual([
    {
      method: "readFile",
      value: "rules/typescript/no-inferable-type-annotation.md",
    },
  ]);
  expect(rules).toEqual({
    "typescript/no-inferable-type-annotation": {
      files: ["**/*.{ts,tsx,mts,cts}", "!**/*.test.ts"],
      invariant: [
        "# Do not annotate inferable types",
        "",
        "Do not declare a type annotation that TypeScript can infer from the value.",
      ].join("\n"),
    },
  });
});
