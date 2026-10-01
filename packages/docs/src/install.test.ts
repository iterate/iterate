import { expect, test } from "vitest";
import { DocContract, DocsContract } from "./contract.ts";
import { docsAgentsSection, docsModule, ensureDoc, installDocs } from "./install.ts";

// install.ts spells the processors' consumes itself: the page imports it, and contract.ts pulls in
// iterate/stream/processor, which a browser can't load
test("opening a doc enables each processor on everything its contract consumes", async () => {
  const enabled: Record<string, unknown> = {};
  const context = (path: string): any => ({
    cd: context,
    append: async () => [],
    processors: {
      enable: async (slug: string, row: { consumes: string[] }) => {
        enabled[`${path} ${slug}`] = row.consumes;
      },
    },
  });

  await ensureDoc(context("/"), { repo: "/repos/config", path: "plan.md" });

  expect(enabled).toEqual({
    "/ docs": DocsContract.consumes,
    "/docs/config/plan.md doc": DocContract.consumes,
  });
});

test("installing Docs commits docs.ts, the pin beside the config's other dependencies and the agent guide's pointer, and waits for its publication", async () => {
  const commits: any[] = [];
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "config",
      dependencies: { "@iterate-com/voice": "1.0.0" },
    }),
    "AGENTS.md": "# Config\n\nThe project's own words.\n",
  };
  const project: any = {
    repos: {
      get: () => ({
        tip: async () => "c0",
        readFile: async (path: string) => files[path] || null,
        commitFiles: async (input: any) => {
          commits.push(input);
          return { commitOid: "c1" };
        },
      }),
    },
    waitForEvent: async (input: any) => ({
      type: "events.iterate.com/project/worker-updated",
      payload: input.payload,
      offset: 1,
    }),
  };

  expect(
    await installDocs(project, "https://pkg.pr.new/iterate/iterate/@iterate-com/docs@abc"),
  ).toBe("c1");
  expect(commits).toMatchObject([
    {
      parent: "c0",
      changes: [
        docsModule,
        {
          path: "package.json",
          content: `${JSON.stringify(
            {
              name: "config",
              dependencies: {
                "@iterate-com/voice": "1.0.0",
                "@iterate-com/docs": "https://pkg.pr.new/iterate/iterate/@iterate-com/docs@abc",
              },
            },
            null,
            2,
          )}\n`,
        },
        {
          path: "AGENTS.md",
          content: `# Config\n\nThe project's own words.\n\n${docsAgentsSection}`,
        },
      ],
    },
  ]);

  // installed again: the pointer is there already, and stays as it is
  files["AGENTS.md"] = commits[0].changes[2].content;
  await installDocs(project, "https://pkg.pr.new/iterate/iterate/@iterate-com/docs@def");
  expect(commits[1].changes.map((change: any) => change.path)).toEqual(["docs.ts", "package.json"]);
});
