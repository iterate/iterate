// The agents and voice apps installed as packages by the default template (core/configs/default).
import { expect, test } from "vitest";
import { createdProject, freshCtx, openItx, readAll, until } from "../../helpers/client.ts";
import { FakeAi } from "../../helpers/fake-ai.ts";
import { assistantWords, configureModel } from "./fixtures.ts";
import { publishedPackage } from "./support.ts";

test(
  "a project with no template pins this checkout's agents and voice builds, its init installs them, and an agent answers",
  { timeout: 90_000 },
  async () => {
    const agents = await publishedPackage("@iterate-com/agents");
    const voice = await publishedPackage("@iterate-com/voice");
    const root = await createdProject(openItx(freshCtx("agents-template")), "agents-template");
    const manifest = await root.repos.get("/repos/config").readFile("package.json");
    expect(JSON.parse(manifest)).toMatchObject({
      dependencies: { "@iterate-com/agents": agents, "@iterate-com/voice": voice },
    });
    // The first load of a new build resolves it through esm.sh; every later one reads the lock.
    await until(
      "the init case installed agents and voice",
      async () =>
        (await root.rewriteRules.get("itx.agents"))?.target &&
        (await root.rewriteRules.get("itx.voice"))?.target,
      60_000,
    );
    expect(await root.voice.health()).toMatchObject({ ok: true });
    // the default sets no schedule: an idle project sleeps (core/configs/heartbeat sets one)
    expect(await root.schedules.list()).toEqual([]);
    const path = "/agents/first";
    const agent = root.cd(path);
    await agent.provide("itx.ai", new FakeAi(["Hello from the published package."]));
    await root.agents.create(path);
    await configureModel(agent);
    await root.agents.get(path).message("Say hello.");
    await until("the agent's reply", async () =>
      assistantWords(await readAll(agent)).includes("Hello from the published package."),
    );
    expect((await readAll(root)).filter((event) => /failed$/.test(event.type))).toEqual([]);
  },
);
