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
//   10. runtime matrix: same scripts from Node, CLI, POST script, dynamic
//       worker, and a real browser
//   11. client-normalized raw SDK-shaped live providers and disconnect/offline
//   12. Slack-shaped non-live provider backed by a stored dynamic-worker address
//   13. dynamic worker nested RpcTarget auto-proxying
//   14. worker-to-worker composition through env.ITX.get()
//   15. dynamic Durable Object facets are isolated per mounted capability path
//   16. inherited __global__ catalog stays scoped to the socket principal
//   17. describe() exposes the agent → project → __global__ capability chain
//   18. own capabilities shadow built-ins, and revoke restores the built-in
//   19. trusted durable-object.path built-ins replay their prefix
//   20. failed scripts still fold a completed error record
//   21. codemode can durably provide a capability for later callers
//   22. root ITX control names are reserved and cannot be shadowed
//
// Each capability test uses a FRESH agent coordinate (prj:shared/agents/<rand>)
// so durable state never bleeds between runs. The chain test reuses prj:shared
// as the parent but only with sturdy/replace-safe provides.

import assert from "node:assert";
import { withItx } from "./client.ts";
import {
  dynamicCalc,
  MATRIX_EXAMPLES,
  MATRIX_RUNTIMES,
  repoCounter,
  runRuntimeMatrix,
} from "./runtime-matrix.ts";

const TOKEN = "alice-token"; // principal "alice" → projects ["alice", "shared"]
const BASE_URL = process.env.ITX_BASE ?? "http://127.0.0.1:8788";
const rid = Math.random().toString(36).slice(2, 8);
const agentPath = (label: string) => `/agents/${label}-${rid}`;
const projectItx = () => withItx({ projectId: "shared", path: "/", token: TOKEN });
const agentItx = (label: string) =>
  withItx({ projectId: "shared", path: agentPath(label), token: TOKEN });

const nestedKitWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "kit.js",
    modules: {
      "kit.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class MathTarget extends RpcTarget {
          add(a, b) { return a + b; }
        }
        export class KitEntrypoint extends WorkerEntrypoint {
          echo(value) { return { echoed: value }; }
          get math() { return new MathTarget(); }
        }
      `,
    },
  },
  entrypoint: "KitEntrypoint",
  props: {},
};

const addressedSlackWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "slack.js",
    modules: {
      "slack.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class ChatTarget extends RpcTarget {
          postMessage(body) {
            return {
              args: [body],
              method: "chat.postMessage",
              provider: "dynamic-worker-address",
            };
          }
        }
        export class SlackEntrypoint extends WorkerEntrypoint {
          get chat() { return new ChatTarget(); }
        }
      `,
    },
  },
  entrypoint: "SlackEntrypoint",
  props: {},
};

const inventoryWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "inventory.js",
    modules: {
      "inventory.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class Skus extends RpcTarget {
          priceOf({ sku }) { return sku === "ABC" ? 42 : 0; }
        }
        export class InventoryEntrypoint extends WorkerEntrypoint {
          count() { return 7; }
          get skus() { return new Skus(); }
        }
      `,
    },
  },
  entrypoint: "InventoryEntrypoint",
  props: {},
};

const reportWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "report.js",
    modules: {
      "report.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export class ReportEntrypoint extends WorkerEntrypoint {
          async build({ sku }) {
            const itx = await this.env.ITX.get();
            const count = await itx.inventory.count();
            const price = await itx.inventory.skus.priceOf({ sku });
            return { count, price, total: count * price };
          }
        }
      `,
    },
  },
  entrypoint: "ReportEntrypoint",
  props: {},
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

const postScript = (path: string, code: string) =>
  fetch(`${BASE_URL}/api/itx?projectId=shared&path=${encodeURIComponent(path)}`, {
    body: code,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    method: "POST",
  });

await check("1. live capability: provide → invoke → describe → revoke", async () => {
  const itx = agentItx("live");
  try {
    let called = 0;
    await itx.provideCapability({
      path: ["logsomething"],
      capability: () => {
        called++;
        console.log("called");
        return "logged";
      },
    });
    assert.equal(await itx.logsomething(), "logged");
    assert.equal(called, 1, "a bare function capability is still a callable leaf");

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
  const path = agentPath("code");
  const itx = agentItx("code");
  try {
    await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    const response = await postScript(
      path,
      `async (itx) => itx.invokeCapability({ path: ["calc", "add"], args: [10, 20] })`,
    );
    assert.equal(response.status, 200);
    const output = (await response.json()) as any;
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
  const response = await postScript(agentPath("post"), `async () => "curlable"`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.result, "curlable");
  const execution = body.describe.scriptExecutions.find(
    (x: any) => x.executionId === body.executionId,
  );
  assert.equal(execution?.status, "completed");
  assert.equal(execution?.result, "curlable");
});

await check(
  `10. runtime matrix: ${MATRIX_EXAMPLES.length} examples × ${MATRIX_RUNTIMES.length} runtimes`,
  async () => {
    await runRuntimeMatrix(rid);
  },
);

await check("11. raw SDK-shaped live provider is client-normalized and goes offline", async () => {
  const path = agentPath("live-sdk");
  const provider = withItx({ projectId: "shared", path, token: TOKEN });
  try {
    // This is deliberately a raw class instance, like `new Slack.WebClient()`,
    // not a pre-shaped plain object. Bare Cap'n Web cannot serialize this kind
    // of object by value; `withItx` wraps it into a live
    // invokeCapability({ path, args }) provider before it crosses the socket.
    class SlackLikeWebClient {
      #token = "xoxb-test";
      chat = {
        postMessage: (body: unknown) => ({
          args: [body],
          method: "chat.postMessage",
          provider: "live-session",
          token: this.#token,
        }),
      };
    }

    await provider.provideCapability({ path: ["slack"], capability: new SlackLikeWebClient() });
    assert.deepEqual(await provider.slack.chat.postMessage({ text: "hi" }), {
      args: [{ text: "hi" }],
      method: "chat.postMessage",
      provider: "live-session",
      token: "xoxb-test",
    });
  } finally {
    dispose(provider);
  }

  // The event log still records the live row (`address: null`), but its stub was
  // in the disconnected provider session, so later consumers see an offline cap.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const consumer = withItx({ projectId: "shared", path, token: TOKEN });
  try {
    const row = (await consumer.describe()).capabilities.find(
      (c: any) => c.path.join(".") === "slack",
    );
    assert.equal(row?.address, null);
    await assert.rejects(
      async () => await consumer.slack.chat.postMessage({ text: "after disconnect" }),
      /offline|closed|broken|disposed|disconnect|no longer running|network connection lost/i,
    );
  } finally {
    dispose(consumer);
  }
});

await check("12. Slack-shaped non-live provider is a stored dynamic-worker address", async () => {
  const itx = agentItx("addressed-slack");
  try {
    // Same caller shape as the live SDK test above:
    //   await itx.slack.chat.postMessage(...)
    //
    // The difference is the lifetime. This provided value is plain address data,
    // so `provideCapability` writes the address into the event log and stores no
    // in-memory live stub. Later calls dial the dynamic worker from that address,
    // then replay the unresolved suffix `chat.postMessage` on the loaded entrypoint.
    await itx.provideCapability({ path: ["slack"], capability: addressedSlackWorker });
    assert.deepEqual(await itx.slack.chat.postMessage({ text: "hi from address" }), {
      args: [{ text: "hi from address" }],
      method: "chat.postMessage",
      provider: "dynamic-worker-address",
    });

    const row = (await itx.describe()).capabilities.find((c: any) => c.path.join(".") === "slack");
    assert.equal(row?.address?.type, "dynamic-worker");
    assert.equal(row?.address?.entrypoint, "SlackEntrypoint");
  } finally {
    dispose(itx);
  }
});

await check("13. dynamic worker auto-proxy reaches nested RpcTarget members", async () => {
  const itx = agentItx("nested-worker");
  try {
    // This is stronger than the calc smoke test: the dynamic worker returns a
    // nested RpcTarget (`math`) and callers still use one naked dotted path.
    await itx.provideCapability({ path: ["kit"], capability: nestedKitWorker });
    assert.deepEqual(await itx.kit.echo({ hi: 1 }), { echoed: { hi: 1 } });
    assert.equal(await itx.kit.math.add(2, 3), 5);
  } finally {
    dispose(itx);
  }
});

await check("14. worker-to-worker composition uses the worker's scoped env.ITX.get()", async () => {
  const itx = agentItx("worker-to-worker");
  try {
    // `report` has no direct binding to `inventory`; it discovers it through
    // its own ITX handle, exactly like an agent-authored dynamic worker should.
    await itx.provideCapability({ path: ["inventory"], capability: inventoryWorker });
    await itx.provideCapability({ path: ["report"], capability: reportWorker });
    assert.deepEqual(await itx.report.build({ sku: "ABC" }), {
      count: 7,
      price: 42,
      total: 294,
    });
  } finally {
    dispose(itx);
  }
});

await check(
  "15. dynamic Durable Object facets are isolated per mounted capability path",
  async () => {
    const itx = agentItx("facet-isolation");
    try {
      // Same repo source and same DO class, but two capability mounts. The mount
      // path is part of the host-owned identity, so each counter has separate
      // storage.
      await itx.provideCapability({ path: ["counterA"], capability: repoCounter });
      await itx.provideCapability({ path: ["counterB"], capability: repoCounter });
      assert.equal(await itx.counterA.increment(), 1);
      assert.equal(await itx.counterB.increment(), 1);
      assert.equal(await itx.counterA.current(), 1);
      assert.equal(await itx.counterB.current(), 1);
    } finally {
      dispose(itx);
    }
  },
);

await check("16. inherited __global__ projects catalog is principal-scoped", async () => {
  const project = projectItx();
  try {
    // The project context parents to __global__, but the edge session still
    // scopes that inherited catalog to Alice's projects.
    assert.deepEqual([...(await project.projects.list())].sort(), ["alice", "shared"]);
    await assert.rejects(async () => await project.projects.get("bob"));
  } finally {
    dispose(project);
  }
});

await check("17. describe nests agent → project → __global__ built-ins", async () => {
  const agent = agentItx("describe-chain");
  try {
    // describe() is the one read verb: local folded caps, local built-ins, then
    // parentCapabilities recursively until the stateless root.
    const d = await agent.describe();
    assert.ok(d.builtins.some((c: any) => c.path.join(".") === "whoami"));
    assert.ok(d.parentCapabilities?.builtins.some((c: any) => c.path.join(".") === "fetch"));
    assert.ok(d.parentCapabilities?.builtins.some((c: any) => c.path.join(".") === "repo"));
    assert.ok(
      d.parentCapabilities?.parentCapabilities?.builtins.some(
        (c: any) => c.path.join(".") === "projects",
      ),
    );
    assert.equal(d.parentCapabilities?.parentCapabilities?.parentCapabilities, undefined);
  } finally {
    dispose(agent);
  }
});

await check("18. own capability shadows and then restores a built-in", async () => {
  const agent = agentItx("shadow-builtin");
  try {
    // Own folded capabilities resolve before constructor-injected built-ins. An
    // exact revoke removes only the own row, so the built-in resurfaces.
    const original = await agent.whoami();
    await agent.provideCapability({ path: ["whoami"], capability: () => "shadowed" });
    assert.equal(await agent.whoami(), "shadowed");
    await agent.revokeCapability({ path: ["whoami"] });
    assert.equal(await agent.whoami(), original);
  } finally {
    dispose(agent);
  }
});

await check("19. trusted durable-object built-in replays its path prefix", async () => {
  const project = projectItx();
  try {
    // Project `fetch` is a trusted durable-object address whose stored prefix is
    // ["egress"]. The caller invokes `fetch(...)`; dial replays egress first.
    assert.deepEqual(await project.fetch("data:text/plain,hello"), {
      body: "hello",
      status: 200,
      viaProject: "shared",
    });
  } finally {
    dispose(project);
  }
});

await check("20. failed scripts still fold a completed error record", async () => {
  const path = agentPath("script-error");
  const itx = agentItx("script-error");
  try {
    // Script executions are durable audit records even when the code throws.
    const code = `async () => { throw new Error("boom"); }`;
    const response = await postScript(path, code);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /boom/);
    const execution = (await itx.describe()).scriptExecutions.find((x: any) => x.code === code);
    assert.equal(execution?.status, "completed");
    assert.match(execution?.error ?? "", /boom/);
  } finally {
    dispose(itx);
  }
});

await check("21. codemode can durably provide a capability for later callers", async () => {
  const path = agentPath("script-provide");
  const response = await postScript(
    path,
    `async (itx) => {
        await itx.provideCapability({
          path: ["calc2"],
          capability: ${JSON.stringify(dynamicCalc)},
        });
        return "provided";
      }`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.result, "provided");

  const itx = withItx({ projectId: "shared", path, token: TOKEN });
  try {
    assert.equal(await itx.calc2.add(20, 22), 42);
    const row = (await itx.describe()).capabilities.find((c: any) => c.path.join(".") === "calc2");
    assert.equal(row?.address?.type, "dynamic-worker");
  } finally {
    dispose(itx);
  }
});

await check("22. root ITX control names are reserved and cannot be shadowed", async () => {
  const itx = agentItx("reserved-control-name");
  try {
    // The ergonomic dotted surface uses the same namespace for control calls
    // (`itx.describe()`) and capability calls (`itx.slack.send()`). Keep that
    // understandable by reserving the root ITX control names outright instead
    // of allowing user capabilities to shadow them.
    await assert.rejects(
      async () => itx.provideCapability({ path: ["describe"], capability: () => "shadow" }),
      /reserved ITX control path/,
    );
    const description = await itx.describe();
    assert.equal(typeof description, "object");
    assert.equal(
      description.capabilities.some((cap: any) => cap.path.join(".") === "describe"),
      false,
    );
  } finally {
    dispose(itx);
  }
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
