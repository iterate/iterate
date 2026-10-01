// The agents app installed by the default template (core/configs/default), from the platform.
import { expect, test } from "vitest";
import { createdProject, freshCtx, openItx, readAll, until } from "../../helpers/client.ts";
import { preset } from "../../helpers/project-host.ts";
import { FakeAi } from "../../helpers/fake-ai.ts";
import { assistantWords, configureModel } from "./fixtures.ts";

test("a project on the Default preset lists no packages, its init installs the platform's agents, and an agent answers", async () => {
  const root = await createdProject(
    openItx(freshCtx("agents-template")),
    "agents-template",
    await preset("Default"),
  );
  const manifest = await root.repos.get("/repos/config").readFile("package.json");
  expect(JSON.parse(manifest)).not.toHaveProperty("dependencies");
  await until(
    "the init case installed agents",
    async () => (await root.rewriteRules.get("itx.agents"))?.target,
  );
  // the default sets no schedule: an idle project sleeps (its heartbeat is commented out)
  expect(await root.schedules.list()).toEqual([]);
  const path = "/agents/first";
  const agent = root.cd(path);
  await agent.provide("itx.ai", new FakeAi(["Hello from the platform's agents."]));
  await root.agents.create(path);
  await configureModel(agent);
  await root.agents.get(path).message("Say hello.");
  await until("the agent's reply", async () =>
    assistantWords(await readAll(agent)).includes("Hello from the platform's agents."),
  );
  expect((await readAll(root)).filter((event) => /failed$/.test(event.type))).toEqual([]);
});
