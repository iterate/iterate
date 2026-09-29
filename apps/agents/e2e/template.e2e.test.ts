// THE AGENTS AND VOICE APPS INSTALLED AS PACKAGES: a project created with no template gets the
// default one (configs/default), which the deployment embeds with `@iterate-com/agents` and
// `@iterate-com/voice` pinned to this checkout's pkg.pr.new build and installs from its own init
// case; the loader resolves the packages through esm.sh.
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "../../os/e2e/support/client.ts";
import { FakeAi } from "../../os/e2e/support/fake-ai.ts";
import { assistantWords, configureModel } from "./fixtures.ts";
import { publishedPackage } from "./support.ts";

test("a project created with no template pins the agents and voice packages at this checkout's published build", async () => {
  const agents = await publishedPackage("@iterate-com/agents");
  const voice = await publishedPackage("@iterate-com/voice");
  const root = await createDefaultProject("agents-template-pin");
  const manifest = await root.repos.get("/repos/config").readFile("package.json");
  expect(JSON.parse(manifest)).toMatchObject({
    dependencies: { "@iterate-com/agents": agents, "@iterate-com/voice": voice },
  });
});

test(
  "the default template installs the published agents and voice packages from its init case, and an agent answers a message",
  { timeout: 90_000 },
  async () => {
    await publishedPackage("@iterate-com/agents");
    await publishedPackage("@iterate-com/voice");
    const root = await createDefaultProject("agents-template");
    // The first load of a new build resolves it through esm.sh; every later one reads the lock.
    await until(
      "the init case installed agents and voice",
      async () =>
        (await root.rewriteRules.get("itx.agents"))?.target &&
        (await root.rewriteRules.get("itx.voice"))?.target,
      60_000,
    );
    expect(await root.voice.health()).toMatchObject({ ok: true });
    // the default sets no schedule: an idle project sleeps (configs/heartbeat sets one)
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

/** A root created the way `projects.create` creates one, with no template: the default, seeded. */
async function createDefaultProject(name: string) {
  const root = openItx(freshCtx(name));
  await root.processors.enable("project");
  await root.append({
    type: "events.iterate.com/project/create-requested",
    payload: { slug: name, orgId: "test" },
  });
  const created = await root.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  expect(created).toMatchObject({ type: "events.iterate.com/project/created" });
  return root;
}
