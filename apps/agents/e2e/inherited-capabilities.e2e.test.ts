import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { freshCtx, rejection } from "../../os/e2e/support/client.ts";
import { openAgentItx } from "./support.ts";

test("THE CHAIN: a subagent two levels down resolves a capability provided at the root through parent links, lists it with its description and origin, and births its own children relative to itself", async () => {
  const ctx = freshCtx("chain");
  const root = await openAgentItx(ctx);
  await root.provide({
    match: "itx.tool",
    target: () => "hello-from-root",
    description: "says hello",
  });
  await root.agents.create("/agents/a");
  // /agents/a was linked to its creator (the root). An agent's scripts run in ITS SANDBOX
  // (`/agents/a/sandbox`, linked to the agent), so a script there that creates `./b` births
  // `/agents/a/sandbox/b`, linked to the sandbox — a child never holds more than its creator.
  const sub = "/agents/a/sandbox/b";
  expect(
    await root
      .cd("/agents/a")
      .run(
        "async (itx) => { await itx.agents.create('./b'); return (await itx.cd('./b').rewriteRules.list()).filter((r) => r.match === 'itx').map((r) => r.target); }",
      ),
  ).toEqual(["itx.cd('/agents/a/sandbox')"]); // the child's own link, pointing at its creator
  expect(await root.cd(sub).builtins.rewriteRules.get("itx")).toMatchObject({
    target: "itx.cd('/agents/a/sandbox')",
  });
  // three hops down, the root's stub answers, and the list says where it came from
  expect(await root.cd(sub).run("async (itx) => itx.tool()")).toBe("hello-from-root");
  const rows = (await root.cd(sub).rewriteRules.list()) as {
    match: string;
    context: string;
    description?: string;
  }[];
  expect(rows.find((row) => row.match === "itx.tool")).toMatchObject({
    context: "/",
    description: "says hello",
  });
  expect(rows.find((row) => row.match === "itx.kv")).toMatchObject({ context: "/" });
  expect(rows.find((row) => row.match === "itx.append")).toMatchObject({ context: sub });
  // nothing project-level is implicit below the root: a mask at /agents/a stops the chain there —
  // and the list agrees: the mask is inherited as a mask, and no spellable row is left beneath it
  // (the root's `itx.tool` and its longer `itx.tool.deep` alike)
  await root.provide("itx.tool.deep", () => "deeper");
  await root.cd("/agents/a").provide("itx.tool", null);
  const afterMask = (await root.cd(sub).rewriteRules.list()) as {
    match: string;
    target: string | null;
    context: string;
  }[];
  expect(afterMask.filter((row) => row.match.startsWith("itx.tool"))).toEqual([
    { match: "itx.tool", target: null, context: "/agents/a" },
  ]);
  // (a run's failure crosses the log as the settlement's TEXT, never a code)
  expect((await rejection(root.cd(sub).run("async (itx) => itx.tool()"))).message).toMatch(
    /is masked/,
  );
});

test("an agent cannot create an ancestor and invert its parent capability chain", async () => {
  const root = await openAgentItx(freshCtx("agent-ancestor"));
  await root.agents.create("/agents/child");
  const ancestor = root.cd("/agents");
  const rules = await ancestor.rewriteRules.list();
  const processors = await ancestor.processors.list();
  await expect(
    root.cd("/agents/child").run("async (itx) => itx.agents.create('/agents')"),
  ).rejects.toThrow(/cannot create its own ancestor/);
  expect(await ancestor.rewriteRules.list()).toEqual(rules);
  expect(await ancestor.processors.list()).toEqual(processors);
  expect(await root.agents.list()).toEqual([
    { path: "/agents/child", createdAt: expect.any(String) },
  ]);
});

test("a script cannot choose its new agent's parent link: the child links to the context that created it, whatever `creator` the call names", async () => {
  const root = await openAgentItx(freshCtx("agent-creator"));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.agents.create("/agents/a");
  await root.cd("/agents/a").provide("itx.tool", null);
  // The script runs in /agents/a/sandbox, beneath the mask, and names the root as the creator.
  const { links, tool } = (await root
    .cd("/agents/a")
    .run(
      "async (itx) => { await itx.agents.create('./b', { creator: '/' }); const links = (await itx.cd('./b').rewriteRules.list()).filter((r) => r.match === 'itx').map((r) => r.target); const tool = await itx.cd('./b').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
    )) as { links: string[]; tool: string };
  expect(links, "the child's parent link should be its caller's own context").toEqual([
    "itx.cd('/agents/a/sandbox')",
  ]);
  expect(tool).toMatch(/is masked/);
});

// Pinned: the root's `itx.agents` row is inherited by every context linked to the root, and the
// collection it reaches links each agent to its own base, `/`, never to the context that asked.
createFailing(test, /parent link should be the context that created it/)(
  "a context linked to the root cannot reach past its own mask through an agent it creates with the root's `itx.agents`",
  async () => {
    const root = await openAgentItx(freshCtx("agent-root-linked"));
    await root.provide("itx.tool", () => "hello-from-root");
    await root.workspaces.create("/jail");
    const jail = root.cd("/jail");
    await jail.provide("itx.tool", null);
    const { links, tool } = (await jail.builtins.run(
      "async (itx) => { await itx.agents.create('./a'); const links = (await itx.cd('./a').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/jail/a').map((r) => r.target); const tool = await itx.cd('./a').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
    )) as { links: string[]; tool: string };
    expect(links, "the agent's parent link should be the context that created it").toEqual([
      "itx.cd('/jail')",
    ]);
    expect(tool).toMatch(/is masked/);
  },
);
