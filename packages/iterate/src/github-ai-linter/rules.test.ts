import { expect, test } from "vitest";
import { loadGithubAiLinterRules } from "./rules.ts";

test("the linter loads its configured Markdown rules from one repository glob", async () => {
  const calls: Array<{ method: string; value: string }> = [];
  const repo = {
    glob: async (pattern: string) => {
      calls.push({ method: "glob", value: pattern });
      return {
        commitOid: "abc123",
        paths: ["rules/typescript/no-inferable-type-annotation.md"],
      };
    },
    readFile: async ({ commitOid, path }: { commitOid: string; path: string }) => {
      calls.push({ method: "readFile", value: `${commitOid}:${path}` });
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
    glob: "rules/**/*.md",
    repoPath: "/repos/iterate",
  });

  expect(calls).toEqual([
    { method: "glob", value: "rules/**/*.md" },
    {
      method: "readFile",
      value: "abc123:rules/typescript/no-inferable-type-annotation.md",
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
