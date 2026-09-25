import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { installVoice } from "@iterate-com/voice/install";
import { freshCtx, rejection } from "../../os/e2e/support/client.ts";
import { openAgentItx, voiceWorkspaceSource } from "./support.ts";
import { ScriptedAi, answeredLog, assistantWords, configureModel } from "./fixtures.ts";

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

// PINNED, ONE CAUSE: the agents collection is a userspace facet on `/` that cannot see who called
// it, and it acts with the root's authority. The root's `itx.agents` row is inherited by every context
// linked to the root, and an agent's own row reaches the same facet through the public `at(base)`, so
// a context beneath a mask can have that facet write for it. Closing these needs the platform to
// hand a facet the caller's originating context (`Caller.path`, which the library already uses for
// repos and workspaces: apps/os/src/library.ts `createEntity`).
const linkedToTheRootBeneathAMask = async (name: string) => {
  const root = await openAgentItx(freshCtx(name));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.workspaces.create("/jail");
  const jail = root.cd("/jail");
  await jail.provide("itx.tool", null);
  return { root, jail };
};

createFailing(test, /parent link should be the context that created it/)(
  "a context linked to the root cannot reach past its own mask through an agent it creates with the root's `itx.agents`",
  async () => {
    const { jail } = await linkedToTheRootBeneathAMask("agent-root-linked");
    const { links, tool } = (await jail.builtins.run(
      "async (itx) => { await itx.agents.create('/jail/a'); const links = (await itx.cd('./a').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/jail/a').map((r) => r.target); const tool = await itx.cd('./a').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
    )) as { links: string[]; tool: string };
    expect(links, "the agent's parent link should be the context that created it").toEqual([
      "itx.cd('/jail')",
    ]);
    expect(tool).toMatch(/is masked/);
  },
);

createFailing(test, /should land beneath the context that asked/)(
  "a context linked to the root that creates `./a` with the root's `itx.agents` gets its own `./a`",
  async () => {
    const { jail } = await linkedToTheRootBeneathAMask("agent-root-linked-relative");
    const { path } = (await jail.builtins.run("async (itx) => itx.agents.create('./a')")) as {
      path: string;
    };
    expect(path, "a relative agent path should land beneath the context that asked").toBe(
      "/jail/a",
    );
  },
);

createFailing(test, /should not reach past the mask/)(
  "an agent's script cannot unmask itself by appending a parent link through `itx.agents.get(path).append`",
  async () => {
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
  },
);

createFailing(test, /voice agent's parent link should be the context that asked/, {
  timeoutMs: 60_000,
})(
  "a context linked to the root cannot reach past its own mask through a voice agent it sets up with the root's `itx.voice`",
  async () => {
    const { root, jail } = await linkedToTheRootBeneathAMask("voice-root-linked");
    await root.secrets.set("/secrets/openai", "placeholder-openai-key", {
      urls: ["https://api.openai.com"],
    });
    await installVoice(root, await voiceWorkspaceSource());
    // The voice worker is loaded code at `/` whose `env.ITX` is its own, so it creates every agent
    // through the root's `itx.agents`, at whatever absolute `streamPath` the caller names.
    const { links, tool } = (await jail.builtins.run(
      "async (itx) => { await itx.voice.setupVoiceAgent({ streamPath: '/jail/v', activation: 'pin' }); const links = (await itx.cd('./v').rewriteRules.list()).filter((r) => r.match === 'itx' && r.context === '/jail/v').map((r) => r.target); const tool = await itx.cd('./v').tool().then((v) => v, (e) => String(e.message)); return { links, tool }; }",
    )) as { links: string[]; tool: string };
    expect(links, "the voice agent's parent link should be the context that asked").toEqual([
      "itx.cd('/jail')",
    ]);
    expect(tool).toMatch(/is masked/);
  },
);

// ONE PROJECT, ONE TRUST BOUNDARY: one agent messages another, and the words land stamped with the
// sender (apps/os src/caller.ts `stampCaller`). The receiver takes a turn on a user's words from
// anyone in the project, names the sender to the model, and does not listen to a delete request from
// beside it (packages/agents contract.ts `trust`).
createFailing(test, /should be stamped with the agent that sent it/, { timeoutMs: 90_000 })(
  "an agent messages another: the words land stamped with the sender's sandbox and raise a turn that names it; a delete request from beside the receiver changes nothing",
  async () => {
    const root = await openAgentItx(freshCtx("agent-to-agent"));
    const ai = new ScriptedAi(["Hello, a."]);
    await root.cd("/agents/b").provide("itx.ai", ai);
    await root.agents.create("/agents/a");
    await root.agents.create("/agents/b");
    await configureModel(root.cd("/agents/b"));
    const { message, deleteRequest } = (await root
      .cd("/agents/a")
      .run(
        "async (itx) => { const b = itx.agents.get('/agents/b'); const message = await b.message('hello from a'); const [deleteRequest] = await b.append({ type: 'events.iterate.com/agent/delete-requested', payload: {} }); return { message, deleteRequest }; }",
      )) as {
      message: { source?: unknown };
      deleteRequest: { offset: number; source?: unknown };
    };
    const { source: said } = message;
    const { source: asked } = deleteRequest;
    expect(said, "a message should be stamped with the agent that sent it").toEqual({
      origin: "/agents/a/sandbox",
    });
    expect(asked).toEqual({ origin: "/agents/a/sandbox" });
    const log = await answeredLog(root.cd("/agents/b"), "b's answer to a");
    expect(assistantWords(log)).toEqual(["Hello, a."]);
    expect(ai.calls[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "[from /agents/a/sandbox] hello from a",
    });
    const agent = root.cd("/agents/b").facets.get("agent");
    await agent.waitUntilProcessed({ offset: deleteRequest.offset });
    expect((await agent.snapshot()).state.deletion).toBeNull();
    expect((await root.agents.list()).map((row: { path: string }) => row.path)).toEqual([
      "/agents/a",
      "/agents/b",
    ]);
  },
);
