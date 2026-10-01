import { installAgents } from "iterate/agents/install";
import { expect, test } from "vitest";
import { freshCtx, openItx, publishConfig, readAll, until } from "../../helpers/client.ts";
import { FakeAi } from "../../helpers/fake-ai.ts";
import { facetStartedAt } from "../../helpers/residency-facets.ts";
import { agentsWorkspaceConfig } from "../agents-workers/agents-workspace-config.ts";
import { assistantWords, configureModel } from "./fixtures.ts";
import { installWorkspaceApps } from "./support.ts";

test("installing again keeps agents, their grants and history, and puts back a removed agents rewrite", async () => {
  const itx = openItx(freshCtx("agents-install"));
  expect((await itx.rewriteRules.get("itx.agents"))?.target).toBeFalsy();
  await installWorkspaceApps(itx);
  const rule = await itx.rewriteRules.get("itx.agents");
  const rootRows = await itx.processors.list();
  await itx.agents.create("/agents/support");
  const context = itx.cd("/agents/support");
  await context.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.secrets", target: null },
  });
  await context.provide("itx.ai", new FakeAi(["Before reinstall.", "After reinstall."]));
  await configureModel(context);
  await itx.agents.get("/agents/support").message("Remember this conversation.");
  await until("first reply", async () => assistantWords(await readAll(context)).length === 1);
  const grants = await context.rewriteRules.list();
  const history = await readAll(context);
  const agentRows = await context.processors.list();
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.agents", target: null },
  });

  await installWorkspaceApps(itx); // as the init case does after every commit
  expect(await itx.rewriteRules.get("itx.agents")).toEqual(rule);
  expect(await itx.processors.list()).toEqual(rootRows);
  expect(await itx.agents.list()).toEqual([
    { path: "/agents/support", createdAt: expect.any(String) },
  ]);
  expect(await context.processors.list()).toEqual(agentRows);
  expect(await context.rewriteRules.list()).toEqual(grants);
  expect((await readAll(context)).slice(0, history.length)).toEqual(history);
  await itx.agents.get("/agents/support").message("Continue after the reinstall.");
  await until("second reply", async () => assistantWords(await readAll(context)).length === 2);
  expect(assistantWords(await readAll(context))).toEqual(["Before reinstall.", "After reinstall."]);
});

// Three publications, each waiting out the 5 s snapshot TTL: up to a minute on a preview, so `slow`.
test(
  "through publication: a commit that changes only the website keeps the agent running as it booted; one that changes the agents' code restarts it on its next call, its conversation kept",
  { tags: ["slow"], timeout: 120_000 },
  async () => {
    const itx = openItx(freshCtx("agents-publication"));
    await publishConfig(itx, agentsWorkspaceConfig);
    await installAgents(itx);
    await itx.agents.create("/agents/support");
    const context = itx.cd("/agents/support");
    await context.provide("itx.ai", new FakeAi(["First.", "Second.", "Third."]));
    await configureModel(context);
    const agent = context.facets.get("agent");
    const replies = async (n: number) =>
      until(`reply ${n}`, async () => assistantWords(await readAll(context)).length === n);
    await itx.agents.get("/agents/support").message("One.");
    await replies(1);
    const booted = await facetStartedAt(agent);

    // the website changes, the agents' module does not: the same boot answers
    await publishConfig(itx, {
      ...agentsWorkspaceConfig,
      "worker.ts": `${agentsWorkspaceConfig["worker.ts"]}export const homepage = "v2";\n`,
    });
    await itx.agents.get("/agents/support").message("Two.");
    await replies(2);
    expect(await facetStartedAt(agent)).toBe(booted);

    // the agents' own code changes: its next call boots the new code, the conversation kept
    await publishConfig(itx, {
      ...agentsWorkspaceConfig,
      "agents.ts": `${agentsWorkspaceConfig["agents.ts"]}\n// the next version\n`,
    });
    await itx.agents.get("/agents/support").message("Three.");
    await replies(3);
    expect(await facetStartedAt(agent)).toBeGreaterThan(booted);
    expect(assistantWords(await readAll(context))).toEqual(["First.", "Second.", "Third."]);
  },
);
