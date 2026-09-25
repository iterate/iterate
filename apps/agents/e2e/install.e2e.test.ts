import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "../../os/e2e/support/client.ts";
import { agentRuntimeSource } from "../src/lib/agent-runtime-source.ts";
import { installAgents } from "../../../configs/with-agents/agents/install.ts";
import { ScriptedAi, assistantWords, configureModel } from "./fixtures.ts";

test("install and reinstall preserve existing agents, sandbox grants and conversation history", async () => {
  const itx = openItx(freshCtx("agents-install"));
  const source = agentRuntimeSource;
  const oldSource = {
    ...source,
    "index.ts": `${source["index.ts"]}\n// previous release\n`,
  };
  expect((await itx.rewriteRules.get("itx.agents"))?.target).toBeFalsy();
  await installAgents(itx, oldSource);
  const oldRule = await itx.rewriteRules.get("itx.agents");
  await itx.agents.create("/agents/support");
  const context = itx.cd("/agents/support");
  const sandbox = context.cd("sandbox");
  await sandbox.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.secrets", target: null },
  });
  // the sandbox's own grants and its agent's: the root's rows it inherits include the app's own
  // `itx.agents`, which an install replaces
  const sandboxGrants = async () =>
    ((await sandbox.rewriteRules.list()) as { context: string }[]).filter(
      (row) => row.context !== "/",
    );
  await context.provide("itx.ai", new ScriptedAi(["Before upgrade.", "After upgrade."]));
  await configureModel(context);
  await itx.agents.get("/agents/support").message("Remember this conversation.");
  await until("first reply", async () => assistantWords(await readAll(context)).length === 1);
  const grants = await sandboxGrants();
  const history = await readAll(context);
  const previous = await context.processors.list();

  await installAgents(itx, source);
  expect(await itx.agents.list()).toEqual([
    { path: "/agents/support", createdAt: expect.any(String) },
  ]);
  expect(await sandboxGrants()).toEqual(grants);
  expect((await readAll(context)).slice(0, history.length)).toEqual(history);
  expect(await context.processors.list()).not.toEqual(previous);
  await itx.agents.get("/agents/support").message("Continue after the upgrade.");
  await until("second reply", async () => assistantWords(await readAll(context)).length === 2);
  expect(assistantWords(await readAll(context))).toEqual(["Before upgrade.", "After upgrade."]);

  const installedRows = await context.processors.list();
  await installAgents(itx, source);
  expect(await context.processors.list()).toEqual(installedRows);
  expect(await sandboxGrants()).toEqual(grants);
  await installAgents(itx, oldSource);
  expect(await itx.rewriteRules.get("itx.agents")).toEqual(oldRule);
});

test("a removed agents rewrite can be installed again with the same runtime", async () => {
  const itx = openItx(freshCtx("agents-reinstall"));
  const source = agentRuntimeSource;
  await installAgents(itx, source);
  const installed = await itx.rewriteRules.get("itx.agents");
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.agents", target: null },
  });
  await installAgents(itx, source);
  expect(await itx.rewriteRules.get("itx.agents")).toEqual(installed);
  expect(await itx.agents.list()).toEqual([]);
});
