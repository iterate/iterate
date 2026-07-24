import { expect, test } from "vitest";
import { loadGithubAiLinterRules } from "./rules.ts";

test("the linter filters one production-shaped repository snapshot into configured Markdown rules", async () => {
  const calls: Array<{ method: string; value: string }> = [];
  const repo = {
    listFiles: async () => {
      calls.push({ method: "listFiles", value: "/repos/iterate" });
      return {
        commitOid: "abc123",
        paths: [
          "README.md",
          "rules/typescript/no-inferable-type-annotation.md",
          "rules/typescript/not-markdown.txt",
        ],
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
    { method: "listFiles", value: "/repos/iterate" },
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
