import { expect, test } from "vitest";
import { openAgentItx } from "./support.ts";
import { freshCtx, rejection } from "../../os-next/e2e/support/client.ts";

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
