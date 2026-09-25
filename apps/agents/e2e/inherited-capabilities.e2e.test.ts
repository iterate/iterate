import { expect, test } from "vitest";
import { freshCtx, rejection } from "../../os/e2e/support/client.ts";
import { buildVoiceInstall } from "../scripts/build-voice-install.ts";
import { ensureVoiceAgent } from "../voice/install.ts";
import { openAgentItx } from "./support.ts";

test("THE CHAIN: a subagent two levels down resolves a capability provided at the root through parent links, lists it with its description and origin, and births its own children relative to itself", async () => {
  const ctx = freshCtx("chain");
  const root = await openAgentItx(ctx);
  await root.provide("itx.tool", () => "hello-from-root", { description: "says hello" });
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
  ).rejects.toThrow(/reaches only the agents beneath it, not "\/agents"/);
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

test("a context linked to the root cannot reach past its own mask through an agent it creates with the root's `itx.agents`", async () => {
  const { jail } = await linkedToTheRootBeneathAMask("agent-root-linked");
  const { links, tool } = (await jail.builtins.run(
    "async (itx) => { await itx.agents.create('/jail/a'); const links = (await itx.cd('./a').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/jail/a').map((r) => r.target); const tool = await itx.cd('./a').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
  )) as { links: string[]; tool: string };
  expect(links, "the agent's parent link should be the context that created it").toEqual([
    "itx.cd('/jail')",
  ]);
  expect(tool).toMatch(/is masked/);
});

test("a context linked to the root that creates `./a` with the root's `itx.agents` gets its own `./a`", async () => {
  const { jail } = await linkedToTheRootBeneathAMask("agent-root-linked-relative");
  const { path } = (await jail.builtins.run("async (itx) => itx.agents.create('./a')")) as {
    path: string;
  };
  expect(path, "a relative agent path should land beneath the context that asked").toBe("/jail/a");
});

test("a context linked to the root reaches only the agents beneath itself through the root's `itx.agents`: it cannot list, message, delete or announce the death of an agent elsewhere, widen with `at`, upgrade, or append a script run", async () => {
  const { root, jail } = await linkedToTheRootBeneathAMask("agent-root-linked-reach");
  await root.agents.create("/agents/other");
  const answers = await jail.builtins.run(
    "async (itx) => { const refused = (call) => call.then(() => 'allowed', (e) => String(e.message)); return { list: await itx.agents.list(), message: await refused(itx.agents.get('/agents/other').message('hi')), delete: await refused(itx.agents.delete('/agents/other')), announce: await refused(itx.agents.announce({ type: 'events.iterate.com/agent/deleted', payload: { path: '/agents/other' } })), widen: await refused(itx.agents.at('/').list()), upgrade: await refused(itx.agents.upgrade()), run: await refused(itx.agents.get('./x').append({ type: 'events.iterate.com/itx/run-requested', payload: { code: 'async () => 1' } })) }; }",
  );
  expect(answers).toEqual({
    list: [],
    message: expect.stringMatching(/at "\/jail" reaches only the agents beneath it/),
    delete: expect.stringMatching(/at "\/jail" reaches only the agents beneath it/),
    announce: expect.stringMatching(/announces only its own certificate/),
    widen: expect.stringMatching(/at "\/jail" reaches only the agents beneath it, not "\/"/),
    upgrade: expect.stringMatching(/the root's, not "\/jail"'s/),
    run: expect.stringMatching(
      /"events\.iterate\.com\/itx\/run-requested" is not an event the agent contract owns/,
    ),
  });
  // the other agent is alive: the root still lists it
  expect(await root.agents.list()).toEqual([
    { path: "/agents/other", createdAt: expect.any(String) },
  ]);
});

test("an agent's script cannot unmask itself by appending a parent link through `itx.agents.get(path).append`", async () => {
  const root = await openAgentItx(freshCtx("agent-reference-append"));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.agents.create("/agents/a");
  await root.cd("/agents/a").provide("itx.tool", null);
  // The script runs in /agents/a/sandbox, beneath the mask; the facet appends with the root's authority.
  const tool = await root
    .cd("/agents/a")
    .run(
      "async (itx) => { await itx.agents.get('./x').append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx', target: \"itx.cd('/')\" } }).catch(() => {}); return itx.cd('./x').tool().then((v) => v, (e) => String(e.message)); }",
    );
  expect(tool, "a script beneath a mask should not reach past the mask").not.toBe(
    "hello-from-root",
  );
});

test("a context linked to the root cannot reach past its own mask through a voice agent it sets up with the root's `itx.voice`", async () => {
  const { root, jail } = await linkedToTheRootBeneathAMask("voice-root-linked");
  const install = await buildVoiceInstall();
  await ensureVoiceAgent(root, async () => install, "placeholder-openai-key");
  // The voice worker is loaded code at `/` whose `env.ITX` is its own: it creates through the
  // root's `itx.agents` narrowed to the caller its row names (`props.caller`).
  const { links, tool } = (await jail.builtins.run(
    "async (itx) => { await itx.voice.setupVoiceAgent({ streamPath: '/jail/v', activation: 'pin' }); const links = (await itx.cd('./v').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/jail/v').map((r) => r.target); const tool = await itx.cd('./v').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
  )) as { links: string[]; tool: string };
  expect(links, "the voice agent's parent link should be the context that asked").toEqual([
    "itx.cd('/jail')",
  ]);
  expect(tool).toMatch(/is masked/);
});

// The agents collection is a facet on `/` that acts with the root's reach, and every context linked to
// the root inherits the root's `itx.agents`. The row hands the facet `@caller`, the context the call
// started at, which the platform stamps and nobody can name; the collection stays beneath it, so a
// context beneath a mask cannot have the facet write past that mask for it.
const linkedToTheRootBeneathAMask = async (name: string) => {
  const root = await openAgentItx(freshCtx(name));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.workspaces.create("/jail");
  const jail = root.cd("/jail");
  await jail.provide("itx.tool", null);
  return { root, jail };
};
