import { beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";
import { baseUrl, connectUnauthenticated, ensureProject, tokenAuth } from "./e2e-env.ts";
import type {
  ProjectItxRpc,
  ProjectWorkerRpc,
  RpcStub,
  StreamEvent,
  UnauthenticatedItxRpc,
} from "./src/client.ts";

const payloadFor = (events: StreamEvent[], type: string) =>
  events.find((event) => event.type === type)?.payload;

const callMissing = (target: unknown, method: string) =>
  Reflect.apply(Reflect.get(target as object, method), target, []);

const projectItx = <T extends ProjectItxRpc = ProjectItxRpc>(
  unauthenticated: RpcStub<UnauthenticatedItxRpc>,
) =>
  unauthenticated.authenticate({
    auth: tokenAuth(),
    projectId: "prj_ref",
  }) as unknown as RpcStub<T>;

function connectWithCookie(cookie: string): RpcStub<UnauthenticatedItxRpc> {
  const url = new URL("/api/itx", baseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.toString(), {
    headers: { cookie },
    handshakeTimeout: 10_000,
  });
  return newWebSocketRpcSession<UnauthenticatedItxRpc>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

describe("minimal itx v2", () => {
  beforeAll(async () => {
    await ensureProject();
  });

  test("reaches stateless built-ins directly", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

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

  test("authenticates from a server-set cookie", async () => {
    const response = await fetch(new URL("/api/login", baseUrl()), {
      body: "alice-token",
      method: "POST",
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    using unauthenticated = connectWithCookie(cookie!);
    using itx = unauthenticated.authenticate({
      auth: { type: "from-server-cookie" },
      projectId: "prj_ref",
    }) as unknown as RpcStub<ProjectItxRpc>;

    expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
  });

  test("project domain RPC does not expose its local stream loopback", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    await expect(callMissing(itx.project, "stream")).rejects.toThrow();
  });

  test("agents.get returns an agent domain handle", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    const agent = itx.agents.get("/agents/bla");
    expect(await agent.whoami()).toBe("agent prj_ref:/agents/bla");
    expect(await agent.project().repo().whoami()).toBe("repo prj_ref:/repos/project");
  });

  test("collection create forwards payloads to domain create methods", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);
    const agentPath = `/agents/created-agent-${crypto.randomUUID()}`;
    const repoPath = `/repos/created-repo-${crypto.randomUUID()}`;

    const agentCreated = await itx.agents.create({
      label: "Ada",
      path: agentPath,
    });
    expect(agentCreated.type).toBe("events.iterate.com/agent/created");
    expect(agentCreated.payload).toEqual({ label: "Ada" });

    const agentEvents = await itx.streams.get(agentPath).getEvents({ afterOffset: 0 });
    expect(payloadFor(agentEvents, "events.iterate.com/agent/create-requested")).toEqual({
      label: "Ada",
    });

    const repoCreated = await itx.repos.create({
      branch: "main",
      path: repoPath,
    });
    expect(repoCreated.type).toBe("events.iterate.com/repo/created");
    expect(repoCreated.payload).toMatchObject({
      artifactName: expect.any(String),
      branch: "main",
      defaultBranch: "main",
      remote: expect.any(String),
    });

    const repoEvents = await itx.streams.get(repoPath).getEvents({ afterOffset: 0 });
    expect(payloadFor(repoEvents, "events.iterate.com/repo/create-requested")).toEqual({
      branch: "main",
    });

    const streamEvent = await itx.streams.get("/streams/implicit").append({
      event: {
        type: "events.iterate.com/test/implicit-stream-created",
        payload: { purpose: "logs" },
      },
    });
    expect(streamEvent.payload).toEqual({ purpose: "logs" });
  });

  test("project itx has no agent built-in", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    await expect(callMissing(Reflect.get(itx, "agent"), "whoami")).rejects.toThrow(
      /no capability "agent.whoami"/,
    );
  });

  test("provides, invokes, and explicitly revokes a live capability", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<
      ProjectItxRpc & {
        echo: { ping(input: { text: string }): string };
      }
    >(callerRoot);

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
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    await expect(
      itx.provideCapability({
        capability: { ping: () => "pong" },
        path: ["streams"],
      }),
    ).rejects.toThrow(/already on this ITX target/);
  });

  test("runs scripts through the host itx processor", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    const result = await itx.runScript({
      code: `async (itx) => {
        const repo = await itx.repo;
        return await repo.whoami();
      }`,
    });

    expect(result.result).toBe("repo prj_ref:/repos/project");
  });

  test("exposes the project worker default entrypoint", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    expect(await itx.worker.add(2, 3)).toBe(5);
    expect(await itx.worker.greet("itx")).toBe("hello, itx");
  });

  test("provides the default project worker as a capability", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { projectWorker: ProjectWorkerRpc }>(callerRoot);

    await provider.provideCapability({
      capability: {
        add(a: number, b: number) {
          return provider.worker.add(a, b);
        },
        greet(name?: string) {
          return provider.worker.greet(name);
        },
      },
      path: ["projectWorker"],
    });

    expect(await caller.projectWorker.add(4, 5)).toBe(9);
    expect(await caller.projectWorker.greet("capability")).toBe("hello, capability");
  });

  test("provides a project worker ref as a capability", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { projectWorkerRef: ProjectWorkerRpc }>(callerRoot);

    await provider.provideCapability({
      capability: {
        source: {
          repoPath: "/repos/project",
          sourcePath: "worker.js",
          type: "from-repo",
        },
        type: "worker-entrypoint",
      },
      path: ["projectWorkerRef"],
    });

    expect(await caller.projectWorkerRef.add(6, 7)).toBe(13);
  });

  test("invokes dynamic workers that call back through env.ITX.authenticate()", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { probe: { repoWhoami(): string } }>(callerRoot);

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
                  const itx = await this.env.ITX.authenticate();
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
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<
      ProjectItxRpc & {
        counterFacet: { current(): number; increment(): number };
      }
    >(callerRoot);
    const cacheKey = `counter-facet-${crypto.randomUUID()}`;

    await provider.provideCapability({
      capability: {
        cacheKey,
        className: "CounterDurableObject",
        source: {
          repoPath: "/repos/project",
          sourcePath: "worker.js",
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
