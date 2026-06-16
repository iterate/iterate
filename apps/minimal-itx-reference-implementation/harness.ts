// harness.ts — the e2e test. Run `npm run dev` (terminal 1), then `npm run e2e`.
//
// Drives every core itx concept through a NAKED Cap'n Web stub over a real
// WebSocket to real workerd + a real Stream Durable Object:
//
//   1. live capability round-trip: provide → invoke → describe → revoke
//   2. deep dotted paths into a mounted object + longest-prefix shadow
//   3. dynamic-worker: a dialable address built + run via the Worker Loader
//   4. dynamic-durable-object: repo source from counter.js run as a facet
//   5. the chain: an agent inherits its project's caps and can shadow them
//   6. the __global__ root: the projects catalog, and provide is read-only
//   7. auth at the connect door: bad token / no access are refused
//   8. codemode: a loaded script gets an itx handle and calls back
//   9. POST /api/itx runs a script and folds requested/completed events
//
// Each capability test uses a FRESH agent coordinate (prj:shared/agents/<rand>)
// so durable state never bleeds between runs. The chain test reuses prj:shared
// as the parent but only with sturdy/replace-safe provides.

import assert from "node:assert";
import { withItx } from "./client.ts";

const TOKEN = "alice-token"; // principal "alice" → projects ["alice", "shared"]
const BASE_URL = process.env.ITX_BASE ?? "http://127.0.0.1:8788";
const rid = Math.random().toString(36).slice(2, 8);
const agentPath = (label: string) => `/agents/${label}-${rid}`;
const projectItx = () => withItx({ projectId: "shared", path: "/", token: TOKEN });
const agentItx = (label: string) =>
  withItx({ projectId: "shared", path: agentPath(label), token: TOKEN });

// A dynamic-worker capability: plain data describing code to build + run on demand.
const dynamicCalc = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "calc.js",
    modules: {
      "calc.js": `
      import { WorkerEntrypoint } from "cloudflare:workers";
      export class CounterEntrypoint extends WorkerEntrypoint {
        add(a, b) { return a + b; }
      }
    `,
    },
  },
  entrypoint: "CounterEntrypoint",
  props: {},
};

const repoCounter = {
  type: "dynamic-durable-object",
  source: {
    type: "repo",
    repo: "shared",
    commit: "latest",
    path: "counter.js",
  },
  className: "CounterDurableObject",
};

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (e: any) {
    console.error(`✗ ${name}\n   ${e?.message ?? e}`);
    fail++;
  }
}
const dispose = (s: any) => {
  try {
    s[Symbol.dispose]?.();
  } catch {
    /* already closed */
  }
};

await check("1. live capability: provide → invoke → describe → revoke", async () => {
  const itx = agentItx("live");
  try {
    await itx.provideCapability({
      path: ["greeter"],
      capability: (name: string) => `hi ${name}`,
      instructions: "greets a name",
    });
    // invoke via the explicit verb AND via a naked deep path — both route here.
    assert.equal(await itx.invokeCapability({ path: ["greeter"], args: ["alice"] }), "hi alice");
    assert.equal(await itx.greeter("bob"), "hi bob");

    const d = await itx.describe();
    const row = d.capabilities.find((c: any) => c.path.join(".") === "greeter");
    assert.ok(row, "describe should list the provided capability");
    assert.equal(row.instructions, "greets a name");
    assert.equal(row.address, null, "a live capability has a null address");

    await itx.revokeCapability({ path: ["greeter"] });
    const after = await itx.describe();
    assert.ok(
      !after.capabilities.some((c: any) => c.path.join(".") === "greeter"),
      "revoke should remove the row",
    );
  } finally {
    dispose(itx);
  }
});

await check("2. deep dotted paths + longest-prefix shadow", async () => {
  const itx = agentItx("deep");
  try {
    // Mount a nested object as ONE capability; deep paths pipeline into it.
    await itx.provideCapability({
      path: ["api"],
      capability: { math: { add: (a: number, b: number) => a + b }, echo: (x: string) => x },
    });
    assert.equal(await itx.api.math.add(2, 3), 5);
    assert.equal(await itx.api.echo("ping"), "ping");

    // Shadow the deepest leaf; the broad mount still answers everything else.
    await itx.provideCapability({ path: ["api", "math", "add"], capability: () => 999 });
    assert.equal(await itx.api.math.add(2, 3), 999, "deepest prefix wins");
    assert.equal(await itx.api.echo("pong"), "pong", "broad mount still resolves siblings");
  } finally {
    dispose(itx);
  }
});

await check("3. dynamic-worker: dialed + run via the Worker Loader", async () => {
  const itx = agentItx("sturdy");
  try {
    await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    assert.equal(await itx.calc.add(40, 2), 42, "the loaded isolate runs the method");

    const d = await itx.describe();
    const row = d.capabilities.find((c: any) => c.path.join(".") === "calc");
    assert.ok(row?.address, "a sturdy capability stores its address (not null)");
    assert.equal(row.address.type, "dynamic-worker");
  } finally {
    dispose(itx);
  }
});

await check("4. dynamic-durable-object: repo counter.js runs as a facet", async () => {
  const itx = agentItx("facet");
  try {
    const source = await itx.repo.getWorkerSource({ path: "counter.js" });
    assert.equal(source.mainModule, "counter.js", "the fake repo exposes counter.js");

    await itx.provideCapability({ path: ["counter"], capability: repoCounter });
    assert.equal(await itx.counter.increment(), 1);
    assert.equal(await itx.counter.increment(), 2);
    assert.equal(await itx.counter.current(), 2);
  } finally {
    dispose(itx);
  }
});

await check("5. the chain: agent inherits the project's caps and can shadow", async () => {
  // The project provides a sturdy cap (durable, replace-safe across runs).
  const proj = projectItx();
  try {
    await proj.provideCapability({ path: ["calc"], capability: dynamicCalc });
  } finally {
    dispose(proj);
  }

  const agent = agentItx("chain");
  try {
    // Inherited from the project via the parent chain (the agent never provided it).
    assert.equal(await agent.calc.add(2, 3), 5, "inherited from the project");
    // The agent's OWN built-in (from its Agent DO).
    assert.ok((await agent.whoami()).startsWith("agent "), "agent has its own built-in");
    // Shadow the inherited cap locally; the project is unaffected.
    await agent.provideCapability({
      path: ["calc"],
      capability: { add: (a: number, b: number) => a * b },
    });
    assert.equal(await agent.calc.add(2, 3), 6, "child shadow wins (late binding)");
  } finally {
    dispose(agent);
  }

  const proj2 = projectItx();
  try {
    assert.equal(await proj2.calc.add(2, 3), 5, "the project is unaffected by the agent's shadow");
  } finally {
    dispose(proj2);
  }
});

await check("6. the __global__ root: catalog reads, provide is read-only", async () => {
  const g = withItx({ projectId: "", path: "/", token: TOKEN });
  try {
    const list = await g.projects.list();
    assert.deepEqual([...list].sort(), ["alice", "shared"], "scoped to the principal's reach");
    assert.deepEqual(await g.projects.get("shared"), { id: "shared", ref: "prj:shared" });
    // wrap in async: Cap'n Web returns an RpcPromise (thenable, not `instanceof
    // Promise`), which assert.rejects only accepts via a real returned Promise.
    await assert.rejects(async () => g.projects.get("bob"), "no access to a project out of reach");
    await assert.rejects(
      async () => g.provideCapability({ path: ["x"], capability: () => 1 }),
      "the root is stateless / read-only",
    );
  } finally {
    dispose(g);
  }
});

await check("7. auth at the connect door", async () => {
  const bad = withItx({ projectId: "shared", path: "/", token: "not-a-real-token" });
  await assert.rejects(async () => bad.describe(), "a bad token cannot open a context");
  dispose(bad);

  const denied = withItx({ projectId: "bob", path: "/", token: TOKEN }); // alice has no access to bob
  await assert.rejects(async () => denied.describe(), "no access to the project is refused");
  dispose(denied);
});

await check("8. codemode: a loaded script gets an itx handle and calls back", async () => {
  const itx = agentItx("code");
  try {
    await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    const output = await itx.runScript({
      code: `async (itx) => itx.invokeCapability({ path: ["calc", "add"], args: [10, 20] })`,
    });
    assert.equal(output.result, 30, "the script invoked a capability against its own context");
    const d = await itx.describe();
    const execution = d.scriptExecutions.find((x: any) => x.executionId === output.executionId);
    assert.equal(execution?.status, "completed", "script completion is folded into state");
    assert.equal(execution?.result, 30, "script result is folded into state");
  } finally {
    dispose(itx);
  }
});

await check("9. POST /api/itx runs a script and folds requested/completed events", async () => {
  const response = await fetch(
    `${BASE_URL}/api/itx?projectId=shared&path=${encodeURIComponent(agentPath("post"))}`,
    {
      body: `async () => "curlable"`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      method: "POST",
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.result, "curlable");
  const execution = body.describe.scriptExecutions.find(
    (x: any) => x.executionId === body.executionId,
  );
  assert.equal(execution?.status, "completed");
  assert.equal(execution?.result, "curlable");
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
