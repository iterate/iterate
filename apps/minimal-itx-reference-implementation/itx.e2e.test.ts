// The Node-side e2e suite. Run a worker first (`npm run dev`, or point ITX_BASE
// / APP_CONFIG_BASE_URL at a deployed one), then `npm test`.
//
// Drives every core itx concept through a bare Cap'n Web stub over a real
// WebSocket to real workerd + a real Stream Durable Object, then runs the
// catalogue (examples.ts) across every server-side runtime. The browser leg of
// the matrix is itx.browser.test.ts (vitest's browser project).
//
// Each capability test uses a FRESH agent coordinate (prj_ref:/agents/<rand>)
// so durable state never bleeds between runs. Project-scoped assertions use
// durable/replace-safe provides on prj_ref:/.

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import {
  StreamProcessor,
  type StreamProcessorSnapshot,
} from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";
import { itxHttpUrl, withItx } from "./src/client.ts";
import { baseUrl, connect, ensureProject, token } from "./e2e-env.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./src/examples/example-cases.ts";
import {
  exampleCoordinate,
  MATRIX_RUNTIMES,
  runExampleCode,
  type MatrixRuntime,
} from "./src/examples/example-matrix.ts";
import { ITX_EXAMPLES } from "./src/examples/examples.ts";
import {
  addressedSlackWorker,
  dynamicCalc,
  inventoryWorker,
  nestedKitWorker,
  repoCounter,
  reportWorker,
  upgradeCounter,
} from "./src/examples/itx-scripts.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentPath = (label: string) => `/agents/${label}-${rid}`;
const projectItx = () => connect({ path: "/" });
const agentItx = (label: string) => connect({ path: agentPath(label) });

const SubscribeCounterContract = defineProcessorContract({
  slug: "itx.reference.subscribe-counter",
  version: "0.1.0",
  description: "Counts project stream events delivered through an itx stream subscription.",
  stateSchema: z.object({
    markers: z.array(z.string()).default([]),
    total: z.number().default(0),
  }),
  initialState: {},
  events: {
    "events.iterate.com/test/project-stream-subscribe": {
      payloadSchema: z.object({
        amount: z.number().default(1),
        marker: z.string(),
      }),
    },
  },
  consumes: ["events.iterate.com/test/project-stream-subscribe"],
  emits: [],
});
type SubscribeCounterContract = typeof SubscribeCounterContract;
type SubscribeCounterState = { markers: string[]; total: number };

class SubscribeCounterProcessor extends StreamProcessor<SubscribeCounterContract> {
  readonly contract = SubscribeCounterContract;

  protected override reduce(
    args: Parameters<StreamProcessor<SubscribeCounterContract>["reduce"]>[0],
  ) {
    return {
      markers: [...args.state.markers, args.event.payload.marker],
      total: args.state.total + args.event.payload.amount,
    };
  }
}

beforeAll(async () => {
  await ensureProject("prj_ref");
});

const postProjectScript = (code: string) =>
  fetch(itxHttpUrl({ baseUrl: baseUrl(), projectId: "prj_ref" }), {
    body: code,
    headers: { authorization: `Bearer ${token()}`, "content-type": "text/plain" },
    method: "POST",
  });

const runAgentScript = async (path: string, code: string) => {
  using project = projectItx();
  return await project.agents.get(path).runScript({ code });
};

/** Cap'n Web returns an RpcPromise (thenable, not `instanceof Promise`). Wrap a
 *  call in a real async fn so vitest's `.rejects` can await it. */
const expectRejects = (fn: () => unknown) => expect((async () => await fn())()).rejects;

function announceContract(contract: SubscribeCounterContract) {
  return {
    slug: contract.slug,
    version: contract.version ?? "0",
    description: contract.description ?? "",
    consumes: [...contract.consumes],
    emits: [...(contract.emits ?? [])],
    ownedEvents: Object.entries(contract.events).map(([type, definition]) => ({
      type,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })),
  };
}

describe("itx reference implementation", () => {
  it("1. live capability: provide → invoke → describe → revoke", async () => {
    using itx = agentItx("live");
    let called = 0;
    await itx.provideCapability({
      path: ["logsomething"],
      capability: () => {
        called++;
        return "logged";
      },
    });
    expect(await itx.logsomething()).toBe("logged");
    expect(called).toBe(1);

    await itx.provideCapability({
      path: ["greeter"],
      capability: (name: string) => `hi ${name}`,
      instructions: "greets a name",
    });
    // invoke via the explicit verb AND via a naked deep path — both route here.
    expect(await itx.invokeCapability({ path: ["greeter"], args: ["alice"] })).toBe("hi alice");
    expect(await itx.greeter("bob")).toBe("hi bob");

    const d = await itx.describe();
    const row = d.capabilities.find((c: any) => c.path.join(".") === "greeter");
    expect(row).toBeTruthy();
    expect(row.instructions).toBe("greets a name");
    expect(row.address).toBeNull();

    await itx.revokeCapability({ path: ["greeter"] });
    const after = await itx.describe();
    expect(after.capabilities.some((c: any) => c.path.join(".") === "greeter")).toBe(false);
  });

  it("2. deep dotted paths + longest-prefix shadow", async () => {
    using itx = agentItx("deep");
    // Mount a nested object as ONE capability; deep paths pipeline into it.
    await itx.provideCapability({
      path: ["api"],
      capability: { math: { add: (a: number, b: number) => a + b }, echo: (x: string) => x },
    });
    expect(await itx.api.math.add(2, 3)).toBe(5);
    expect(await itx.api.echo("ping")).toBe("ping");

    // Shadow the deepest leaf; the broad mount still answers everything else.
    await itx.provideCapability({ path: ["api", "math", "add"], capability: () => 999 });
    expect(await itx.api.math.add(2, 3)).toBe(999);
    expect(await itx.api.echo("pong")).toBe("pong");
  });

  it("3. worker-entrypoint: resolved + run via the Worker Loader", async () => {
    using itx = agentItx("dynamic");
    await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    expect(await itx.calc.add(40, 2)).toBe(42);

    const d = await itx.describe();
    const row = d.capabilities.find((c: any) => c.path.join(".") === "calc");
    expect(row?.address).toBeTruthy();
    expect(row.address.type).toBe("worker-entrypoint");
  });

  it("4. durable-object: repo counter.js runs as a facet", async () => {
    using itx = agentItx("facet");
    const source = await itx.project.repo.getWorkerSource({ path: "counter.js" });
    expect(source.mainModule).toBe("counter.js");
    expect(await itx.project.repo.whoami()).toBe("repo prj_ref:/repos/project");

    await itx.provideCapability({ path: ["counter"], capability: repoCounter });
    expect(await itx.counter.increment()).toBe(1);
    expect(await itx.counter.increment()).toBe(2);
    expect(await itx.counter.current()).toBe(2);
  });

  it("5. an agent reaches project capabilities through its explicit project handle", async () => {
    // The project provides a durable dynamic cap (replace-safe across runs).
    {
      using proj = projectItx();
      await proj.provideCapability({ path: ["calc"], capability: dynamicCalc });
    }

    {
      using agent = agentItx("explicit-project");
      expect(await agent.project.calc.add(2, 3)).toBe(5);
      expect((await agent.whoami()).startsWith("agent ")).toBe(true);
      await expectRejects(() => agent.calc.add(2, 3)).toThrow(/no host capability "calc"/);
      // A local cap can use the same name without changing the project.
      await agent.provideCapability({
        path: ["calc"],
        capability: { add: (a: number, b: number) => a * b },
      });
      expect(await agent.calc.add(2, 3)).toBe(6);
    }

    {
      using proj2 = projectItx();
      expect(await proj2.calc.add(2, 3)).toBe(5);
    }
  });

  it("7. auth at the connect door", async () => {
    using bad = withItx({ baseUrl: baseUrl(), projectId: "prj_ref", path: "/", token: "nope" });
    await expectRejects(() => bad.describe()).toThrow();

    using denied = connect({ projectId: "prj_bob", path: "/" });
    await expectRejects(() => denied.describe()).toThrow();
  });

  it("8. codemode: a loaded script gets an itx handle and calls back", async () => {
    const path = agentPath("code");
    using itx = agentItx("code");
    await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    const output = (await runAgentScript(
      path,
      `async (itx) => itx.invokeCapability({ path: ["calc", "add"], args: [10, 20] })`,
    )) as any;
    expect(output.result).toBe(30);
    expect(output.completedEvent.payload).toMatchObject({
      executionId: output.executionId,
      result: 30,
    });
  });

  it("9. POST /api/itx runs a script and returns the completed event", async () => {
    const response = await postProjectScript(`async () => "curlable"`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.result).toBe("curlable");
    expect(body.completedEvent.payload).toMatchObject({
      executionId: body.executionId,
      result: "curlable",
    });
  });

  it("11. raw SDK-shaped live provider is client-normalized and goes offline", async () => {
    const path = agentPath("live-sdk");
    {
      using provider = connect({ path });
      // Deliberately a raw class instance, like `new Slack.WebClient()`. Bare
      // Cap'n Web cannot serialize this by value; `withItx` wraps it into a
      // live invokeCapability({ path, args }) provider before it crosses.
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
      expect(await provider.slack.chat.postMessage({ text: "hi" })).toEqual({
        args: [{ text: "hi" }],
        method: "chat.postMessage",
        provider: "live-session",
        token: "xoxb-test",
      });
    }

    // The event log still records the live row (address: null), but its stub
    // was in the disconnected provider session, so later consumers see offline.
    await new Promise((resolve) => setTimeout(resolve, 25));
    {
      using consumer = connect({ path });
      const row = (await consumer.describe()).capabilities.find(
        (c: any) => c.path.join(".") === "slack",
      );
      expect(row?.address).toBeNull();
      await expectRejects(() =>
        consumer.slack.chat.postMessage({ text: "after disconnect" }),
      ).toThrow(
        /offline|closed|broken|disposed|disconnect|no longer running|network connection lost/i,
      );
    }
  });

  it("12. Slack-shaped non-live provider is a stored worker-entrypoint address", async () => {
    using itx = agentItx("addressed-slack");
    // Same caller shape as the live SDK test, different lifetime: plain address
    // data, so provideCapability writes the address to the log and stores no
    // in-memory stub. Later calls resolve the worker and replay chat.postMessage.
    await itx.provideCapability({ path: ["slack"], capability: addressedSlackWorker });
    expect(await itx.slack.chat.postMessage({ text: "hi from address" })).toEqual({
      args: [{ text: "hi from address" }],
      method: "chat.postMessage",
      provider: "dynamic-worker-address",
    });

    const row = (await itx.describe()).capabilities.find((c: any) => c.path.join(".") === "slack");
    expect(row?.address?.type).toBe("worker-entrypoint");
    expect(row?.address?.entrypoint).toBe("SlackEntrypoint");
  });

  it("13. dynamic worker auto-proxy reaches nested RpcTarget members", async () => {
    using itx = agentItx("nested-worker");
    await itx.provideCapability({ path: ["kit"], capability: nestedKitWorker });
    expect(await itx.kit.echo({ hi: 1 })).toEqual({ echoed: { hi: 1 } });
    expect(await itx.kit.math.add(2, 3)).toBe(5);
  });

  it("14. worker-to-worker composition uses the worker's scoped env.ITX.get()", async () => {
    using itx = agentItx("worker-to-worker");
    // `report` has no direct binding to `inventory`; it discovers it through
    // its own ITX handle, exactly like an agent-authored dynamic worker should.
    await itx.provideCapability({ path: ["inventory"], capability: inventoryWorker });
    await itx.provideCapability({ path: ["report"], capability: reportWorker });
    expect(await itx.report.build({ sku: "ABC" })).toEqual({ count: 7, price: 42, total: 294 });
  });

  it("15. dynamic Durable Object facets are isolated per mounted capability path", async () => {
    using itx = agentItx("facet-isolation");
    // Same repo source and DO class, two mounts. The mount path is part of the
    // host-owned identity, so each counter has separate storage.
    await itx.provideCapability({ path: ["counterA"], capability: repoCounter });
    await itx.provideCapability({ path: ["counterB"], capability: repoCounter });
    expect(await itx.counterA.increment()).toBe(1);
    expect(await itx.counterB.increment()).toBe(1);
    expect(await itx.counterA.current()).toBe(1);
    expect(await itx.counterB.current()).toBe(1);
  });

  it("17. agent ITX is reached through the project-local agents capability", async () => {
    using agent = agentItx("describe-agent");
    const d = await agent.describe();
    expect(d.builtinCapabilities).toHaveLength(2);
    expect(d.builtinCapabilities[0].path).toEqual([]);
    expect(d.builtinCapabilities[0].address).toBeNull();
    expect(d.builtinCapabilities[1].path).toEqual(["workers"]);
    expect(d.builtinCapabilities[1].address).toBeNull();
    expect(await agent.project.egress("data:text/plain,hello")).toMatchObject({
      body: "hello",
      status: 200,
      viaProject: "prj_ref",
    });

    using projectItxHandle = projectItx();
    const project = await projectItxHandle.describe();
    expect(project.builtinCapabilities).toHaveLength(2);
    expect(project.builtinCapabilities[0].path).toEqual([]);
    expect(project.builtinCapabilities[0].address).toBeNull();
    expect(project.builtinCapabilities[1].path).toEqual(["workers"]);
    expect(project.builtinCapabilities[1].address).toBeNull();
    const path = agentPath("via-agents");
    using viaProject = projectItxHandle.agents.get(path);
    expect(await viaProject.whoami()).toBe(`agent prj_ref:${path}`);
    expect((d as any).parentCapabilities).toBeUndefined();
  });

  it("17b. project.streams.get(path) returns a project-scoped stream handle", async () => {
    using project = projectItx();
    const path = `/scratch/streams-${rid}`;
    const stream = project.streams.get(path);

    const appended = await stream.append({
      event: {
        type: "events.iterate.com/test/project-stream",
        payload: { marker: rid },
      },
    });
    expect(typeof appended.offset).toBe("number");

    const events = await stream.getEvents();
    expect(events.at(-1)?.payload).toMatchObject({ marker: rid });
  });

  it("17b2. project stream handles can subscribe a local StreamProcessor through itx", async () => {
    using project = projectItx();
    const path = `/scratch/subscribe-${rid}`;
    const stream = project.streams.get(path);
    const eventType = "events.iterate.com/test/project-stream-subscribe";

    let storedSnapshot: StreamProcessorSnapshot<SubscribeCounterState> | undefined;
    const processor = new SubscribeCounterProcessor({
      iterateContext: {
        stream: {
          append: (args: unknown) => stream.append(args),
          appendBatch: (args: unknown) => stream.appendBatch(args),
        },
      },
      readState: () => storedSnapshot,
      writeState: (snapshot) => {
        storedSnapshot = snapshot;
      },
    });

    const before = `before-${rid}`;
    const replayed = await stream.append({
      event: {
        type: eventType,
        payload: { amount: 2, marker: before },
      },
    });

    const initial = await processor.snapshot();
    const subscription = await stream.subscribe({
      replayAfterOffset: initial.offset,
      eventTypes: [eventType],
      subscriber: {
        description: "minimal-itx-reference e2e local processor",
        processor: {
          announcement: announceContract(processor.contract),
          getRuntimeState: () => processor.getRuntimeState(),
        },
      },
      processEventBatch: (batch: {
        events: Parameters<typeof processor.ingest>[0]["events"];
        streamMaxOffset: number;
      }) => processor.ingest(batch),
    });

    await processor.waitUntilEvent({ offset: replayed.offset, timeoutMs: 8_000 });
    expect(processor.state).toEqual({ markers: [before], total: 2 });

    const during = `during-${rid}`;
    const appended = await stream.append({
      event: {
        type: eventType,
        payload: { amount: 3, marker: during },
      },
    });

    await processor.waitUntilEvent({ offset: appended.offset, timeoutMs: 8_000 });
    expect(processor.state).toEqual({ markers: [before, during], total: 5 });
    expect(storedSnapshot).toEqual({
      offset: appended.offset,
      state: { markers: [before, during], total: 5 },
    });

    const runtimeState = await stream.getProcessorRuntimeState({
      subscriptionKey: subscription.subscriptionKey,
    });
    expect(runtimeState?.snapshot).toMatchObject({
      offset: appended.offset,
      state: { markers: [before, during], total: 5 },
    });

    await subscription.unsubscribe();
    await stream.append({
      event: {
        type: eventType,
        payload: { amount: 99, marker: `after-${rid}` },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(processor.state).toEqual({ markers: [before, during], total: 5 });
  });

  it("17c. project.agents.get(path) returns a full agent-scoped ITX handle", async () => {
    using project = projectItx();
    const path = agentPath("agent-handle-contract");
    using agent = project.agents.get(path);

    expect(await agent.whoami()).toBe(`agent prj_ref:${path}`);
    expect(await agent.project.egress("data:text/plain,from-agent-handle")).toMatchObject({
      body: "from-agent-handle",
      status: 200,
      viaProject: "prj_ref",
    });

    await agent.provideCapability({ path: ["calc"], capability: dynamicCalc });
    expect(await agent.calc.add(19, 23)).toBe(42);

    const script = (await agent.runScript({
      code: `async (itx) => {
        await itx.provideCapability({
          path: ["scriptCalc"],
          capability: ${JSON.stringify(dynamicCalc)},
        });
        return {
          project: await itx.project.egress("data:text/plain,from-script"),
          whoami: await itx.whoami(),
        };
      }`,
    })) as any;
    expect(script.result.whoami).toBe(`agent prj_ref:${path}`);
    expect(script.result.project).toMatchObject({
      body: "from-script",
      status: 200,
      viaProject: "prj_ref",
    });
    expect(await agent.scriptCalc.add(20, 22)).toBe(42);

    await agent.provideCapability({
      path: ["agentProbe"],
      capability: {
        type: "worker-entrypoint",
        source: {
          type: "inline",
          mainModule: "agent-probe.js",
          modules: {
            "agent-probe.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export class AgentProbeEntrypoint extends WorkerEntrypoint {
                async run() {
                  const itx = await this.env.ITX.get();
                  await itx.provideCapability({
                    path: ["workerCalc"],
                    capability: ${JSON.stringify(dynamicCalc)},
                  });
                  const script = await itx.runScript({
                    code: ${JSON.stringify(`async (itx) => itx.whoami()`)},
                  });
                  return {
                    project: await itx.project.egress("data:text/plain,from-worker"),
                    script: script.result,
                    whoami: await itx.whoami(),
                  };
                }
              }
            `,
          },
        },
        entrypoint: "AgentProbeEntrypoint",
        props: {},
      },
    });
    expect(await agent.agentProbe.run()).toEqual({
      project: { body: "from-worker", status: 200, viaProject: "prj_ref" },
      script: `agent prj_ref:${path}`,
      whoami: `agent prj_ref:${path}`,
    });
    expect(await agent.workerCalc.add(21, 21)).toBe(42);

    const description = await agent.describe();
    expect(description.capabilities.some((cap: any) => cap.path.join(".") === "workerCalc")).toBe(
      true,
    );
  });

  it("18. own capability shadows and then restores a built-in", async () => {
    using agent = agentItx("shadow-builtin");
    const original = await agent.whoami();
    await agent.provideCapability({ path: ["whoami"], capability: () => "shadowed" });
    expect(await agent.whoami()).toBe("shadowed");
    await agent.revokeCapability({ path: ["whoami"] });
    expect(await agent.whoami()).toBe(original);
  });

  it("19. project egress is a host runtime built-in", async () => {
    using project = projectItx();
    expect(await project.egress("data:text/plain,hello")).toEqual({
      body: "hello",
      status: 200,
      viaProject: "prj_ref",
    });
  });

  it("20. failed scripts throw the script error", async () => {
    const path = agentPath("script-error");
    const code = `async () => { throw new Error("boom"); }`;
    await expectRejects(() => runAgentScript(path, code)).toThrow(/boom/);
  });

  it("21. codemode can durably provide a capability for later callers", async () => {
    const path = agentPath("script-provide");
    const body = (await runAgentScript(
      path,
      `async (itx) => {
          await itx.provideCapability({
            path: ["calc2"],
            capability: ${JSON.stringify(dynamicCalc)},
          });
          return "provided";
        }`,
    )) as any;
    expect(body.result).toBe("provided");

    using itx = connect({ path });
    expect(await itx.calc2.add(20, 22)).toBe(42);
    const row = (await itx.describe()).capabilities.find((c: any) => c.path.join(".") === "calc2");
    expect(row?.address?.type).toBe("worker-entrypoint");
  });

  it("22. root ITX control names are reserved and cannot be shadowed", async () => {
    using itx = agentItx("reserved-control-name");
    await expectRejects(() =>
      itx.provideCapability({ path: ["describe"], capability: () => "shadow" }),
    ).toThrow(/reserved ITX control root/);
    const description = await itx.describe();
    expect(typeof description).toBe("object");
    expect(description.capabilities.some((cap: any) => cap.path.join(".") === "describe")).toBe(
      false,
    );
  });

  it("23. invalid capability paths are rejected at provide and invoke time", async () => {
    using itx = agentItx("path-validation");
    await expectRejects(() => itx.provideCapability({ path: [], capability: () => "bad" })).toThrow(
      /capability path must contain at least one segment/,
    );
    await expectRejects(() =>
      itx.provideCapability({ path: ["ok", "__proto__"], capability: () => "bad" }),
    ).toThrow(/invalid capability path segment "__proto__"/);
    await expectRejects(() => itx.invokeCapability({ path: [], args: [] })).toThrow(
      /capability path must contain at least one segment/,
    );
    await expectRejects(() =>
      itx.invokeCapability({ path: ["describe", "anything"], args: [] }),
    ).toThrow(/reserved ITX control path "describe"/);
  });

  it("24. live lifecycle: replacement/revoke do not leave stale live invokers", async () => {
    using itx = agentItx("live-lifecycle");
    const calls: string[] = [];
    await itx.provideCapability({
      path: ["switchable"],
      capability: () => {
        calls.push("old");
        return "old";
      },
    });
    expect(await itx.switchable()).toBe("old");

    await itx.provideCapability({
      path: ["switchable"],
      capability: () => {
        calls.push("new");
        return "new";
      },
    });
    expect(await itx.switchable()).toBe("new");
    expect(calls).toEqual(["old", "new"]);

    await itx.revokeCapability({ path: ["switchable"] });
    await expectRejects(() => itx.switchable()).toThrow(/no host capability "switchable"/);
    expect(calls).toEqual(["old", "new"]);
  });

  it("25. dynamic Durable Object source upgrades keep mounted storage", async () => {
    using itx = agentItx("facet-upgrade");
    // The durable identity is the capability mount, not the source hash.
    await itx.provideCapability({ path: ["upgradeCounter"], capability: upgradeCounter("v1") });
    expect(await itx.upgradeCounter.version()).toBe("v1");
    expect(await itx.upgradeCounter.increment()).toBe(1);

    await itx.provideCapability({ path: ["upgradeCounter"], capability: upgradeCounter("v2") });
    expect(await itx.upgradeCounter.version()).toBe("v2");
    expect(await itx.upgradeCounter.current()).toBe(1);
    expect(await itx.upgradeCounter.increment()).toBe(2);
  });
});

// The catalogue (examples.ts) run across every SERVER-side runtime — the same
// script body must produce the same result from Node, the CLI, a POSTed
// script, and a dynamic worker. The browser leg lives in itx.browser.test.ts.
describe("catalogue matrix (server runtimes)", () => {
  it("every runnable catalogue example has a matrix case", () => {
    for (const example of ITX_EXAMPLES) {
      if (EXAMPLE_IDS_WITHOUT_CASES.has(example.id)) continue;
      expect(EXAMPLE_CASES[example.id], `missing matrix case for "${example.id}"`).toBeDefined();
    }
  });

  for (const example of ITX_EXAMPLES) {
    const exampleCase = EXAMPLE_CASES[example.id];
    if (!exampleCase) continue;
    const serverRuntimes = MATRIX_RUNTIMES.filter((runtime) =>
      example.runtimes.includes(runtime),
    ) as MatrixRuntime[];

    it(`runs catalogue example "${example.id}" across [${serverRuntimes.join(", ")}]`, async () => {
      const ctx = exampleCoordinate(example, rid);
      const runCtx = { marker: `node-${rid}`, projectId: ctx.projectId };

      // Setup once against the prj_ref coordinate; every runtime connects to it.
      if (exampleCase.setup) {
        using itx = connect({ path: ctx.path });
        await exampleCase.setup(itx);
      }

      const vars = exampleCase.vars?.(runCtx) ?? {};
      for (const runtime of serverRuntimes) {
        const result = await runExampleCode(runtime, { code: example.code, ctx, vars });
        exampleCase.assert(result, runCtx);
      }
    });
  }
});
