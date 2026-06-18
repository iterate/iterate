import { beforeAll, describe, expect, test } from "vitest";
import { connect, ensureProject } from "./e2e-env.ts";
import type { ProjectItxRpc, StreamEvent } from "./src/client.ts";

const payloadFor = (events: StreamEvent[], type: string) =>
  events.find((event) => event.type === type)?.payload;

const callMissing = (target: unknown, method: string) =>
  Reflect.apply(Reflect.get(target as object, method), target, []);

describe("minimal itx v2", () => {
  beforeAll(async () => {
    await ensureProject();
  });

  test("reaches stateless built-ins directly", async () => {
    using itx = connect();

    expect(await itx.project.repo().whoami()).toBe("repo prj_ref:/repos/project");
    expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
    expect(await itx.repos.get("/repos/project").whoami()).toBe("repo prj_ref:/repos/project");

    const event = await itx.streams.get("/notes").append({
      event: { type: "events.iterate.com/test/note", payload: { text: "hello" } },
    });
    expect(event.type).toBe("events.iterate.com/test/note");

    const events = await itx.streams.get("/notes").getEvents({ afterOffset: event.offset - 1 });
    expect(events.at(-1)?.payload).toEqual({ text: "hello" });
  });

  test("project domain RPC does not expose its local stream loopback", async () => {
    using itx = connect();

    await expect(callMissing(itx.project, "stream")).rejects.toThrow();
  });

  test("agents.get returns an agent domain handle", async () => {
    using itx = connect();

    const agent = itx.agents.get("/agents/bla");
    expect(await agent.whoami()).toBe("agent prj_ref:/agents/bla");
    expect(await agent.project().repo().whoami()).toBe("repo prj_ref:/repos/project");
  });

  test("collection create forwards payloads to domain create methods", async () => {
    using itx = connect();

    const agentCreated = await itx.agents.create({
      label: "Ada",
      path: "/agents/created-agent",
    });
    expect(agentCreated.type).toBe("events.iterate.com/agent/created");
    expect(agentCreated.payload).toEqual({ label: "Ada" });

    const agentEvents = await itx.streams
      .get("/agents/created-agent")
      .getEvents({ afterOffset: 0 });
    expect(payloadFor(agentEvents, "events.iterate.com/agent/create-requested")).toEqual({
      label: "Ada",
    });

    const repoCreated = await itx.repos.create({
      branch: "main",
      path: "/repos/created-repo",
    });
    expect(repoCreated.type).toBe("events.iterate.com/repo/created");
    expect(repoCreated.payload).toEqual({ branch: "main" });

    const repoEvents = await itx.streams.get("/repos/created-repo").getEvents({ afterOffset: 0 });
    expect(payloadFor(repoEvents, "events.iterate.com/repo/create-requested")).toEqual({
      branch: "main",
    });

    const streamCreated = await itx.streams.create({
      purpose: "logs",
      path: "/streams/created-stream",
    });
    expect(streamCreated.type).toBe("events.iterate.com/stream/domain-created");
    expect(streamCreated.payload).toEqual({
      path: "/streams/created-stream",
      projectId: "prj_ref",
      purpose: "logs",
    });

    const streamEvents = await itx.streams
      .get("/streams/created-stream")
      .getEvents({ afterOffset: 0 });
    expect(payloadFor(streamEvents, "events.iterate.com/stream/create-requested")).toEqual({
      purpose: "logs",
    });
  });

  test("project itx has no agent built-in", async () => {
    using itx = connect();

    await expect(callMissing(Reflect.get(itx, "agent"), "whoami")).rejects.toThrow(
      /no capability "agent.whoami"/,
    );
  });

  test("provides, invokes, and explicitly revokes a live capability", async () => {
    using provider = connect();
    using caller = connect<
      ProjectItxRpc & {
        echo: { ping(input: { text: string }): string };
      }
    >();

    const provision = await provider.provideCapability({
      capability: {
        ping(input: { text: string }) {
          return `pong:${input.text}`;
        },
      },
      path: ["echo"],
    });

    expect(await caller.echo.ping({ text: "ok" })).toBe("pong:ok");
    await provision.revoke();
    await expect(caller.echo.ping({ text: "ok" })).rejects.toThrow(/no capability "echo.ping"/);
  });

  test("rejects built-in root shadowing", async () => {
    using itx = connect();

    await expect(
      itx.provideCapability({
        capability: { ping: () => "pong" },
        path: ["streams"],
      }),
    ).rejects.toThrow(/already on this ITX target/);
  });

  test("runs scripts through the host itx processor", async () => {
    using itx = connect();

    const result = await itx.runScript({
      code: `async (itx) => {
        const repo = await itx.repo;
        return await repo.whoami();
      }`,
    });

    expect(result.result).toBe("repo prj_ref:/repos/project");
  });

  test("invokes durable dynamic worker capabilities", async () => {
    using provider = connect();
    using caller = connect<ProjectItxRpc & { counter: { add(a: number, b: number): number } }>();

    await provider.provideCapability({
      capability: {
        entrypoint: "CounterEntrypoint",
        source: {
          repoPath: "/repos/project",
          sourcePath: "counter.js",
          type: "from-repo",
        },
        type: "worker-entrypoint",
      },
      path: ["counter"],
    });

    expect(await caller.counter.add(2, 3)).toBe(5);
  });

  test("invokes dynamic workers that call back through env.ITX.get()", async () => {
    using provider = connect();
    using caller = connect<ProjectItxRpc & { probe: { repoWhoami(): string } }>();

    await provider.provideCapability({
      capability: {
        entrypoint: "ProbeEntrypoint",
        source: {
          mainModule: "probe.js",
          modules: {
            "probe.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export class ProbeEntrypoint extends WorkerEntrypoint {
                async repoWhoami() {
                  const itx = await this.env.ITX.get();
                  const repo = await itx.repo;
                  return await repo.whoami();
                }
              }
            `,
          },
          type: "inline",
        },
        type: "worker-entrypoint",
      },
      path: ["probe"],
    });

    expect(await caller.probe.repoWhoami()).toBe("repo prj_ref:/repos/project");
  });

  test("invokes durable object dynamic capability refs", async () => {
    using provider = connect();
    using caller = connect<
      ProjectItxRpc & {
        counterFacet: { current(): number; increment(): number };
      }
    >();
    const cacheKey = `counter-facet-${crypto.randomUUID()}`;

    await provider.provideCapability({
      capability: {
        cacheKey,
        className: "CounterDurableObject",
        source: {
          repoPath: "/repos/project",
          sourcePath: "counter.js",
          type: "from-repo",
        },
        type: "durable-object",
      },
      path: ["counterFacet"],
    });

    expect(await caller.counterFacet.increment()).toBe(1);
    expect(await caller.counterFacet.current()).toBe(1);
  });
});
