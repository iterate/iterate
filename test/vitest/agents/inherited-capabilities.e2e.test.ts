import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { freshCtx, rejection, until, untilValue } from "../../helpers/client.ts";
import { installWorkspaceApps, openAgentItx, voiceWorkspaceBundle } from "./support.ts";

test("THE CHAIN: a subagent two levels down resolves a capability provided at the root through parent links, lists it with its description and origin, and births its own children relative to itself", async () => {
  const ctx = freshCtx("chain");
  const root = await openAgentItx(ctx);
  await root.provide("itx.tool", () => "hello-from-root", { description: "says hello" });
  await root.agents.create("/agents/a");
  // /agents/a was linked to its creator (the root). An agent's scripts run in its own context, so a
  // script there that creates `./b` births `/agents/a/b`, linked to `/agents/a` — a child never
  // holds more than its creator.
  const sub = "/agents/a/b";
  expect(
    await root
      .cd("/agents/a")
      .run(
        "async (itx) => { await itx.agents.create('./b'); return (await itx.cd('./b').rewriteRules.list()).filter((r) => r.match === 'itx').map((r) => r.target); }",
      ),
  ).toEqual(["itx.cd('/agents/a')"]); // the child's own link, pointing at its creator
  expect(await root.cd(sub).builtins.rewriteRules.get("itx")).toMatchObject({
    target: "itx.cd('/agents/a')",
  });
  // three hops down, the root's stub answers once snapshots catch up, and the list says where it came from
  expect(
    await until("the root's grant reaches the subagent", () =>
      root.cd(sub).run("async (itx) => itx.tool()"),
    ),
  ).toBe("hello-from-root");
  const rows = await untilValue(
    "the subagent lists the root's grant",
    () =>
      root.cd(sub).rewriteRules.list() as Promise<
        { match: string; context: string; description?: string }[]
      >,
    (listed) => listed.some((row) => row.match === "itx.tool"),
  );
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
  // The script runs in /agents/a, beneath the mask, and names the root as the creator.
  const { links, tool } = (await root
    .cd("/agents/a")
    .run(
      "async (itx) => { await itx.agents.create('./b', { creator: '/' }); const links = (await itx.cd('./b').rewriteRules.list()).filter((r) => r.match === 'itx').map((r) => r.target); const tool = await itx.cd('./b').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
    )) as { links: string[]; tool: string };
  expect(links, "the child's parent link should be its caller's own context").toEqual([
    "itx.cd('/agents/a')",
  ]);
  expect(tool).toMatch(/is masked/);
});

// PINNED, ONE CAUSE: the agents collection is a userspace facet on `/` that cannot see who called
// it, and it acts with the root's authority. The root's `itx.agents` row is inherited by every context
// linked to the root, and an agent's own row reaches the same facet through the public `at(base)`, so
// an agent any of them creates is linked to the root (or to whatever base it names), never to the
// context that asked, as repos and workspaces are. Closing these needs the platform to hand a facet
// the caller's originating context (`Caller.path`, which the library already uses for repos and
// workspaces: core/os/src/library.ts `entityRoot`).
const linkedToTheRoot = async (name: string) => {
  const root = await openAgentItx(freshCtx(name));
  await root.workspaces.create("/child");
  return { root, child: root.cd("/child") };
};

createFailing(test, /parent link should be the context that created it/, { timeoutMs: 60_000 })(
  "an agent a context linked to the root creates with the root's `itx.agents` links to that context",
  async () => {
    const { child } = await linkedToTheRoot("agent-root-linked");
    const links = (await child.builtins.run(
      "async (itx) => { await itx.agents.create('/child/a'); return (await itx.cd('./a').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/child/a').map((r) => r.target); }",
    )) as string[];
    expect(links, "the agent's parent link should be the context that created it").toEqual([
      "itx.cd('/child')",
    ]);
  },
);

createFailing(test, /should land beneath the context that asked/, { timeoutMs: 60_000 })(
  "a context linked to the root that creates `./a` with the root's `itx.agents` gets its own `./a`",
  async () => {
    const { child } = await linkedToTheRoot("agent-root-linked-relative");
    const { path } = (await child.builtins.run("async (itx) => itx.agents.create('./a')")) as {
      path: string;
    };
    expect(path, "a relative agent path should land beneath the context that asked").toBe(
      "/child/a",
    );
  },
);

createFailing(test, /voice agent's parent link should be the context that asked/, {
  timeoutMs: 60_000,
})(
  "a voice agent a context linked to the root sets up with the root's `itx.voice` links to that context",
  async () => {
    const { root, child } = await linkedToTheRoot("voice-root-linked");
    await root.secrets.set("/secrets/openai", "placeholder-openai-key", {
      urls: ["https://api.openai.com"],
    });
    await installWorkspaceApps(root, await voiceWorkspaceBundle());
    // The voice worker is loaded code at `/` whose `env.ITX` is its own, so it creates every agent
    // through the root's `itx.agents`, at whatever absolute `streamPath` the caller names.
    const links = (await child.builtins.run(
      "async (itx) => { await itx.voice.setupVoiceAgent({ streamPath: '/child/v', activation: 'pin' }); return (await itx.cd('./v').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/child/v').map((r) => r.target); }",
    )) as string[];
    expect(links, "the voice agent's parent link should be the context that asked").toEqual([
      "itx.cd('/child')",
    ]);
  },
);
