// THE AGENTS APP INSTALLED AS A PACKAGE: a project whose config repo is the with-agents template —
// package.json files that pin @iterate-com/agents (this checkout's pkg.pr.new build) and one
// index.ts that re-exports it, no runtime source — gets working agents from its own config worker:
// `project/created` installs them from `agents/`, the loader resolves the package through esm.sh,
// and a commit that changes `agents/` installs them again from that commit.
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "../../os/e2e/support/client.ts";
import { ScriptedAi, assistantWords, configureModel } from "./fixtures.ts";
import { publishedPackage } from "./support.ts";

const TEMPLATE_FILES = [
  "worker.ts",
  "iterate.json",
  "package.json",
  "AGENTS.md",
  "agents/package.json",
  "agents/index.ts",
];

test(
  "the with-agents template installs the published agents package on project/created, answers a message, and reinstalls from a commit that changes agents/",
  { timeout: 90_000 },
  async () => {
    const root = openItx(freshCtx("agents-template"));
    await expect(root.invoke("itx.agents.list()")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
    });
    const version = await publishedPackage("@iterate-com/agents");
    const template = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@main";
    const changes = await Promise.all(
      TEMPLATE_FILES.map(async (path) => {
        const content = await readFile(
          new URL(`../../../configs/with-agents/${path}`, import.meta.url).pathname,
          "utf8",
        );
        if (path.endsWith("package.json")) expect(content).toContain(template);
        return { path, content: content.replaceAll(template, version) };
      }),
    );
    await root.repos.create("/repos/config");
    const config = root.repos.get("/repos/config");
    await config.commitFiles({ message: "Copy agents template", changes });
    await root.processors.enable("project");
    await root.append({
      type: "events.iterate.com/project/create-requested",
      payload: { slug: "agents-template", orgId: "test" },
    });
    // The first load of a new build resolves it through esm.sh; every later one reads the lock.
    const installed = await until(
      "template installed agents",
      async () => {
        const rule = await root.rewriteRules.get("itx.agents");
        return rule?.target ? rule : undefined;
      },
      60_000,
    ).catch(async (error) => {
      console.log(
        JSON.stringify({
          events: await readAll(root),
          subscriptions: await root.subscriptions.list(),
        }),
      );
      throw error;
    });
    // The installed source is the folder's two files, nothing else: the collection's rule names
    // them, and every agent hosts the collection's own source (packages/agents catalog.ts).
    expect(installed.target).toContain("'index.ts':");
    expect(installed.target).toContain("'package.json':");
    expect(installed.target).toContain(version);

    const path = "/agents/first";
    const agent = root.cd(path);
    await agent.provide("itx.ai", new ScriptedAi(["Hello from the published package."]));
    await root.agents.create(path);
    expect(await root.agents.list()).toEqual([{ path, createdAt: expect.any(String) }]);
    await configureModel(agent);
    await root.agents.get(path).message("Say hello.");
    await until("the agent's reply", async () =>
      assistantWords(await readAll(agent)).includes("Hello from the published package."),
    );

    // A commit that changes agents/ is an upgrade: the config worker installs that commit's folder.
    const index = changes.find((change) => change.path === "agents/index.ts")!.content;
    await config.commitFiles({
      message: "Touch the agents folder",
      changes: [{ path: "agents/index.ts", content: `${index}// upgraded\n` }],
    });
    const reinstalled = await until("reinstalled from the commit", async () => {
      const rule = await root.rewriteRules.get("itx.agents");
      return JSON.stringify(rule.target) !== JSON.stringify(installed.target) ? rule : undefined;
    });
    expect(reinstalled.target).toContain("// upgraded");
    const events = await readAll(root);
    expect(events.filter((event) => /failed$/.test(event.type))).toEqual([]);
    expect(
      (await root.subscriptions.list()).filter((row: { halted?: unknown }) => row.halted),
    ).toEqual([]);
  },
);
