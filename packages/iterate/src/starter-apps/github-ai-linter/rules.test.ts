import { expect, test } from "vitest";
import { loadGithubAiLinterRules } from "./rules.ts";

test("the linter reads only configured rule files", async () => {
  const calls: Array<{ method: string; value: string }> = [];
  const repo = {
    readFile: async ({ commitOid, path }: { commitOid?: string; path: string }) => {
      calls.push({ method: "readFile", value: `${commitOid ?? "HEAD"}:${path}` });
      const id = path.startsWith("rules/structure/")
        ? "structure/no-lame-helpers"
        : "typescript/no-inferable-type-annotation";
      return {
        commitOid: "abc123",
        path,
        content: [
          "---",
          `id: ${id}`,
          "files:",
          "  [",
          '    "**/*.{ts,tsx,mts,cts}",',
          '    "!**/*.test.ts",',
          "  ]",
          "---",
          `# ${id}`,
          "",
          `Apply ${id}.`,
        ].join("\n"),
      };
    },
  };
  const itx = { repos: { get: (path: string) => (path === "/repos/iterate" ? repo : null) } };

  const rules = await loadGithubAiLinterRules(itx as any, {
    paths: [
      "rules/typescript/no-inferable-type-annotation.md",
      "rules/structure/no-lame-helpers.md",
    ],
    repoPath: "/repos/iterate",
  });

  expect(calls).toEqual([
    {
      method: "readFile",
      value: "HEAD:rules/structure/no-lame-helpers.md",
    },
    {
      method: "readFile",
      value: "abc123:rules/typescript/no-inferable-type-annotation.md",
    },
  ]);
  expect(rules).toEqual({
    "structure/no-lame-helpers": {
      files: ["**/*.{ts,tsx,mts,cts}", "!**/*.test.ts"],
      invariant: "# structure/no-lame-helpers\n\nApply structure/no-lame-helpers.",
    },
    "typescript/no-inferable-type-annotation": {
      files: ["**/*.{ts,tsx,mts,cts}", "!**/*.test.ts"],
      invariant:
        "# typescript/no-inferable-type-annotation\n\nApply typescript/no-inferable-type-annotation.",
    },
  });
});
