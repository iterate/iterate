import { beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";
import { baseUrl, connectUnauthenticated, ensureProject, tokenAuth } from "./e2e-env.ts";
import type { StreamEvent } from "./src/client.ts";

type ProjectItxRpc = any;
type ProjectWorkerRpc = any;
type UnauthenticatedItxRpc = any;

const payloadFor = (events: StreamEvent[], type: string) =>
  events.find((event) => event.type === type)?.payload;

const projectItx = <T extends ProjectItxRpc = ProjectItxRpc>(unauthenticated: any): any =>
  unauthenticated.authenticate({
    auth: tokenAuth(),
    projectId: "prj_ref",
  }) as unknown as T;

function connectWithCookie(cookie: string): any {
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

describe("minimal itx v3", () => {
  beforeAll(async () => {
    await ensureProject();
  });

  test("reaches stateless built-ins directly", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

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
    }) as unknown as ProjectItxRpc;

    expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
  });

  test("agents.get returns an agent domain handle", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    const agent = itx.agents.get("/agents/bla");
    expect(await agent.whoami()).toBe("agent prj_ref:/agents/bla");
    expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
  });

  test("collection create forwards payloads to domain create methods", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);
    const agentPath = `/agents/created-agent-${crypto.randomUUID()}`;
    const repoPath = `/repos/created-repo-${crypto.randomUUID()}`;

    const agentCreated = await itx.agents.create({ path: agentPath });
    expect(agentCreated.type).toBe("events.iterate.com/agent/created");
    expect(agentCreated.payload).toEqual({});
    expect(await itx.agents.get(agentPath).whoami()).toBe(`agent prj_ref:${agentPath}`);

    const agentEvents = await itx.streams.get(agentPath).getEvents({ afterOffset: 0 });
    expect(payloadFor(agentEvents, "events.iterate.com/agent/create-requested")).toEqual({});

    const repoCreated = await itx.repos.create({ path: repoPath });
    expect(repoCreated.type).toBe("events.iterate.com/repo/created");
    expect(repoCreated.payload).toMatchObject({
      artifactName: expect.any(String),
      defaultBranch: "main",
      remote: expect.any(String),
    });
    expect(await itx.repos.get(repoPath).whoami()).toBe(`repo prj_ref:${repoPath}`);

    const repoEvents = await itx.streams.get(repoPath).getEvents({ afterOffset: 0 });
    expect(payloadFor(repoEvents, "events.iterate.com/repo/create-requested")).toEqual({});

    const streamEvent = await itx.streams.get("/streams/implicit").append({
      event: {
        type: "events.iterate.com/test/implicit-stream-created",
        payload: { purpose: "logs" },
      },
    });
    expect(streamEvent.payload).toEqual({ purpose: "logs" });
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
        type: "live",
        target: {
          ping(input: { text: string }) {
            return `pong:${input.text}`;
          },
        },
      },
      path: ["echo"],
    });

    expect(await caller.echo.ping({ text: "ok" })).toBe("pong:ok");
    await provision.revoke();
  });

  test("rejects built-in root shadowing", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    await expect(
      itx.provideCapability({
        capability: { type: "live", target: { ping: () => "pong" } },
        path: ["streams"],
      }),
    ).rejects.toThrow(/already on this ITX target/);
  });

  test("runs scripts through the host itx processor", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    const result = await itx.runScript(`async (itx) => {
        const repo = await itx.repo;
        return await repo.whoami();
      }`);

    expect(result.result).toBe("repo prj_ref:/repos/project");
  });

  test("exposes the project worker default entrypoint", async () => {
    using unauthenticated = connectUnauthenticated();
    using itx = projectItx(unauthenticated);

    const response = await itx.worker.fetch(new Request("https://example.com/probe"));
    expect(await response.text()).toBe("project worker fetched /probe");
  });

  test("provides the default project worker as a capability", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { projectWorker: ProjectWorkerRpc }>(callerRoot);

    const provision = await provider.provideCapability({
      capability: {
        type: "live",
        target: {
          async fetch(req: Request) {
            const response = await provider.worker.fetch(req);
            try {
              return new Response(await response.text(), {
                headers: response.headers,
                status: response.status,
                statusText: response.statusText,
              });
            } finally {
              response[Symbol.dispose]?.();
            }
          },
          processEvent(input: { event: StreamEvent }) {
            return provider.worker.processEvent(input);
          },
        },
      },
      path: ["projectWorker"],
    });

    try {
      const response = await caller.projectWorker.fetch(
        new Request("https://example.com/capability"),
      );
      expect(await response.text()).toBe("project worker fetched /capability");
    } finally {
      await provision.revoke();
    }
  });

  test("provides a project worker ref as a capability", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { projectWorkerRef: ProjectWorkerRpc }>(callerRoot);

    const provision = await provider.provideCapability({
      capability: {
        type: "dynamic-worker",
        workerRef: {
          source: {
            repoPath: "/repos/project",
            sourcePath: "worker.js",
            type: "repo",
          },
          target: { type: "worker-entrypoint" },
        },
      },
      path: ["projectWorkerRef"],
    });

    try {
      const response = await caller.projectWorkerRef.fetch(new Request("https://example.com/ref"));
      expect(await response.text()).toBe("project worker fetched /ref");
    } finally {
      await provision.revoke();
    }
  });

  test("invokes dynamic workers that call back through env.ITX.authenticate()", async () => {
    using providerRoot = connectUnauthenticated();
    using provider = projectItx(providerRoot);
    using callerRoot = connectUnauthenticated();
    using caller = projectItx<ProjectItxRpc & { probe: { repoWhoami(): string } }>(callerRoot);

    const provision = await provider.provideCapability({
      capability: {
        type: "dynamic-worker",
        workerRef: {
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
          target: { entrypoint: "ProbeEntrypoint", type: "worker-entrypoint" },
        },
      },
      path: ["probe"],
    });

    try {
      expect(await caller.probe.repoWhoami()).toBe("repo prj_ref:/repos/project");
    } finally {
      await provision.revoke();
    }
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

    const provision = await provider.provideCapability({
      capability: {
        type: "dynamic-worker",
        workerRef: {
          cacheKey,
          source: {
            repoPath: "/repos/project",
            sourcePath: "worker.js",
            type: "repo",
          },
          target: {
            className: "CounterDurableObject",
            type: "durable-object",
          },
        },
      },
      path: ["counterFacet"],
    });

    try {
      expect(await caller.counterFacet.increment()).toBe(1);
      expect(await caller.counterFacet.current()).toBe(1);
    } finally {
      await provision.revoke();
    }
  });
});
