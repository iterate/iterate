import { describe, expect, test } from "vitest";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- this regression test intentionally proves the one-shot HTTP batch shape.
import { newHttpBatchRpcSession } from "capnweb";
import { buildUrl, withItxSession } from "./test-helpers.ts";
import type { ItxWebSocketMessage } from "./test-helpers.ts";
import type { UnauthenticatedItx } from "./types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";

// These are hand written tests - they MUST pass
describe("minimal itx v4", () => {
  test("Unauthenticated itx can't do anything", async () => {
    using session = withItxSession();
    await expect((<any>session).projects).rejects.toThrow();
  });

  test("Authenticated itx whoami returns principal", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: ["prj_alice", "prj_ref"],
        type: "user",
      },
    });

    const projects = itx.projects;

    expect(await itx.whoami()).toBe("alice");
    expect(await projects.list()).toEqual(["prj_alice", "prj_ref"]);
  });

  test("Authenticated itx whoami can create project", async () => {
    const messages: ItxWebSocketMessage[] = [];
    using session = withItxSession({
      onWebSocketMessage: (message) => {
        messages.push(message);
      },
    });
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "alice-project" });
    const description = await project.describe();
    expect(description.projectId).toMatch(/prj_alice$/);
    expect(description.name).toMatch(/prj_alice\.iterate\/$/);
    expect(messages).toContainEqual([
      expect.any(Number),
      "out",
      ["push", ["pipeline", 1, ["projects", "create"], [{ slug: "alice-project" }]]],
    ]);

    using stream = project.streams.get("/");

    const events = await stream.getEvents();

    // We don't care about ordering, just that the stream contains each of these
    // event types. Mapping to types + arrayContaining is the concise idiomatic way.
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/stream/created",
        "events.iterate.com/stream/woken",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/project/create-requested",
        "events.iterate.com/project/created",
        "events.iterate.com/stream/subscriber-disconnected",
      ]),
    );

    const committedEvent = await project.streams.get("/some/path").append({
      type: "hello-world",
    });
    expect(committedEvent).toMatchObject({
      type: "hello-world",
      offset: events.at(-1)!.offset + 1,
    });
    expect(await project.streams.get("/some/path").getEvents()).toMatchObject([
      {
        type: "events.iterate.com/stream/created",
      },
      {
        type: "events.iterate.com/stream/woken",
      },
      committedEvent,
    ]);

    const getSecret = async () => "bananas";

    const { revoke } = await project.provideCapability({
      path: ["someMethodInTestRunner"],
      capability: {
        type: "live",
        target: {
          getSecret: (secretGetter: { getSecret(): Promise<string> }) => secretGetter.getSecret(),
        },
      },
    });

    // @ts-expect-error - TODO maybe some niceties
    expect(await project.someMethodInTestRunner.getSecret(getSecret)).toBe("bananas");

    // make new itx connection

    using newSession = withItxSession();
    using newItx = newSession.authenticate({
      type: "token",
      token: {
        projectScopes: [description.projectId],
        type: "user",
        principal: "alice",
      },
    });

    expect(
      // @ts-expect-error - TODO maybe some niceties
      await newItx.projects.get(description.projectId).someMethodInTestRunner.getSecret(getSecret),
    ).toBe("bananas");

    await revoke();

    // @ts-expect-error
    await expect(project.someMethodInTestRunner.getSecret(getSecret)).rejects.toThrow(
      /no capability "someMethodInTestRunner.getSecret"/,
    );
    await expect(
      // @ts-expect-error - TODO maybe some niceties
      newItx.projects.get(description.projectId).someMethodInTestRunner.getSecret(getSecret),
    ).rejects.toThrow(/no capability "someMethodInTestRunner.getSecret"/);
  });

  // This test is handy because it proves that we really only need one round trip to
  // take all the actions in this itx script
  test("Authenticated itx whoami and projects list complete in one HTTP batch", async () => {
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- if this cannot pipeline in one request, Cap'n Web rejects the batch.
    using session = newHttpBatchRpcSession<UnauthenticatedItx>(buildUrl({ path: "/api/itx" }));
    using itx = session.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: ["prj_alice", "prj_ref"],
        type: "user",
      },
    });
    // If we didn't do Promise.all, this wouldn't work - wouldn't be sent as part of the same batch
    const [principal, projects] = await Promise.all([itx.whoami(), itx.projects.list()]);
    expect(principal).toBe("alice");
    expect(projects).toEqual(["prj_alice", "prj_ref"]);

    // session is now finished - cannot be used again in batch http mode
    await expect(session.authenticate).rejects.toThrow();
  });

  // MAYBE dumb vibecoded test not sure
  test.skip("websocket transport pipelines a batch into a single round trip", async () => {
    // Pipelining proof for the *websocket* transport. The HTTP batch test above
    // proves it for one-shot batches; this one proves the live socket coalesces a
    // pipelined script into a single network round trip too.
    //
    // We measure round trips straight off the wire. test-helpers' onWebSocketMessage
    // hook records every frame with its direction, and capnweb sends each RPC call
    // as its own frame (a "push", plus a "pull" when the result is awaited). The
    // give-away of a round trip is therefore NOT the frame count but the
    // interleaving: a pipelined batch fires all of its outbound frames back to back
    // (one contiguous burst) before blocking on any reply, whereas awaiting between
    // calls forces a reply (an inbound frame) to land mid-stream and splits the
    // outbound frames into separate bursts. So: round trips === number of
    // contiguous outbound bursts.
    const countRoundTrips = (messages: readonly ItxWebSocketMessage[]): number => {
      let roundTrips = 0;
      let previousDirection: ItxWebSocketMessage[1] | undefined;
      for (const [, direction] of messages) {
        if (direction === "out" && previousDirection !== "out") roundTrips += 1;
        previousDirection = direction;
      }
      return roundTrips;
    };

    // Pipelined: authenticate + both reads are issued in the same tick, so every
    // outbound frame leaves before any reply is awaited -> one burst.
    const pipelined: ItxWebSocketMessage[] = [];
    {
      using session = withItxSession({ onWebSocketMessage: (m) => pipelined.push(m) });
      using itx = session.authenticate({
        type: "token",
        token: {
          principal: "alice",
          projectScopes: ["prj_alice", "prj_ref"],
          type: "user",
        },
      });
      const [principal, projects] = await Promise.all([itx.whoami(), itx.projects.list()]);
      expect(principal).toBe("alice");
      expect(projects).toEqual(["prj_alice", "prj_ref"]);
    }

    // Sequential: the same logical work, but each await blocks on a reply before
    // the next call goes out, so the inbound frame splits the outbound frames
    // into separate bursts -> more round trips.
    const sequential: ItxWebSocketMessage[] = [];
    {
      using session = withItxSession({ onWebSocketMessage: (m) => sequential.push(m) });
      using itx = session.authenticate({
        type: "token",
        token: {
          principal: "alice",
          projectScopes: ["prj_alice", "prj_ref"],
          type: "user",
        },
      });
      expect(await itx.whoami()).toBe("alice");
      expect(await itx.projects.list()).toEqual(["prj_alice", "prj_ref"]);
    }

    const pipelinedRoundTrips = countRoundTrips(pipelined);
    const sequentialRoundTrips = countRoundTrips(sequential);

    // The whole point: pipelining collapses the script to a single round trip.
    expect(pipelinedRoundTrips).toBe(1);
    // And it really is a saving over doing the same work one await at a time.
    expect(pipelinedRoundTrips).toBeLessThan(sequentialRoundTrips);
  });
});

// describe.skip("minimal itx v3", () => {
//   beforeAll(async () => {
//     await ensureProject();
//   });

//   test("reaches stateless built-ins directly", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
//     expect(await itx.repos.get("/repos/project").whoami()).toBe("repo prj_ref:/repos/project");

//     const event = await itx.streams.get("/notes").append({
//       event: { type: "events.iterate.com/test/note", payload: { text: "hello" } },
//     });
//     expect(event.type).toBe("events.iterate.com/test/note");

//     const events = await itx.streams.get("/notes").getEvents({ afterOffset: event.offset - 1 });
//     expect(events.at(-1)?.payload).toEqual({ text: "hello" });
//   });

//   test("authenticates from a server-set cookie", async () => {
//     const response = await fetch(new URL("/api/login", baseUrl()), {
//       body: JSON.stringify(aliceToken),
//       method: "POST",
//     });
//     expect(response.status).toBe(200);
//     const cookie = response.headers.get("set-cookie")?.split(";")[0];
//     expect(cookie).toBeTruthy();

//     using unauthenticated = connectWithCookie(cookie!);
//     using itx = unauthenticated.authenticate({
//       auth: { type: "from-server-cookie" },
//       projectId: "prj_ref",
//     }) as unknown as ProjectItxRpc;

//     expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
//   });

//   test("project itx does not expose a nested project shortcut", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     await expect(callMissing(Reflect.get(itx, "project"), "stream")).rejects.toThrow();
//   });

//   test("agents.get returns an agent domain handle", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     const agent = itx.agents.get("/agents/bla");
//     expect(await agent.whoami()).toBe("agent prj_ref:/agents/bla");
//     expect(await itx.repo.whoami()).toBe("repo prj_ref:/repos/project");
//   });

//   test("collection create forwards payloads to domain create methods", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);
//     const agentPath = `/agents/created-agent-${crypto.randomUUID()}`;
//     const repoPath = `/repos/created-repo-${crypto.randomUUID()}`;

//     const agentCreated = await itx.agents.create({ path: agentPath });
//     expect(agentCreated.type).toBe("events.iterate.com/agent/created");
//     expect(agentCreated.payload).toEqual({});
//     expect(await itx.agents.get(agentPath).whoami()).toBe(`agent prj_ref:${agentPath}`);

//     const agentEvents = await itx.streams.get(agentPath).getEvents({ afterOffset: 0 });
//     expect(payloadFor(agentEvents, "events.iterate.com/agent/create-requested")).toEqual({});

//     const repoCreated = await itx.repos.create({ path: repoPath });
//     expect(repoCreated.type).toBe("events.iterate.com/repo/created");
//     expect(repoCreated.payload).toMatchObject({
//       artifactName: expect.any(String),
//       defaultBranch: "main",
//       remote: expect.any(String),
//     });
//     expect(await itx.repos.get(repoPath).whoami()).toBe(`repo prj_ref:${repoPath}`);

//     const repoEvents = await itx.streams.get(repoPath).getEvents({ afterOffset: 0 });
//     expect(payloadFor(repoEvents, "events.iterate.com/repo/create-requested")).toEqual({});

//     const streamEvent = await itx.streams.get("/streams/implicit").append({
//       event: {
//         type: "events.iterate.com/test/implicit-stream-created",
//         payload: { purpose: "logs" },
//       },
//     });
//     expect(streamEvent.payload).toEqual({ purpose: "logs" });
//   });

//   test("project itx has no agent built-in", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     await expect(callMissing(Reflect.get(itx, "agent"), "whoami")).rejects.toThrow(
//       /no capability "agent.whoami"/,
//     );
//   });

//   test("provides, invokes, and explicitly revokes a live capability", async () => {
//     using providerRoot = connectUnauthenticated();
//     using provider = projectItx(providerRoot);
//     using callerRoot = connectUnauthenticated();
//     using caller = projectItx<
//       ProjectItxRpc & {
//         echo: { ping(input: { text: string }): string };
//       }
//     >(callerRoot);

//     const provision = await provider.provideCapability({
//       capability: {
//         type: "live",
//         target: {
//           ping(input: { text: string }) {
//             return `pong:${input.text}`;
//           },
//         },
//       },
//       path: ["echo"],
//     });

//     expect(await caller.echo.ping({ text: "ok" })).toBe("pong:ok");
//     await provision.revoke();
//     await expect(caller.echo.ping({ text: "ok" })).rejects.toThrow(/no capability "echo.ping"/);
//   });

//   test("rejects built-in root shadowing", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     await expect(
//       itx.provideCapability({
//         capability: { type: "live", target: { ping: () => "pong" } },
//         path: ["streams"],
//       }),
//     ).rejects.toThrow(/already on this ITX target/);
//   });

//   test("runs scripts through the host itx processor", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     const result = await itx.runScript(`async (itx) => {
//         const repo = await itx.repo;
//         return await repo.whoami();
//       }`);

//     expect(result.result).toBe("repo prj_ref:/repos/project");
//   });

//   test("exposes the project worker default entrypoint", async () => {
//     using unauthenticated = connectUnauthenticated();
//     using itx = projectItx(unauthenticated);

//     const response = await itx.worker.fetch(new Request("https://example.com/probe"));
//     expect(await response.text()).toBe("project worker fetched /probe");
//   });

//   test("provides the default project worker as a capability", async () => {
//     using providerRoot = connectUnauthenticated();
//     using provider = projectItx(providerRoot);
//     using callerRoot = connectUnauthenticated();
//     using caller = projectItx<ProjectItxRpc & { projectWorker: ProjectWorkerRpc }>(callerRoot);

//     await provider.provideCapability({
//       capability: {
//         type: "live",
//         target: {
//           async fetch(req: Request) {
//             const response = await provider.worker.fetch(req);
//             try {
//               return new Response(await response.text(), {
//                 headers: response.headers,
//                 status: response.status,
//                 statusText: response.statusText,
//               });
//             } finally {
//               response[Symbol.dispose]?.();
//             }
//           },
//           processEvent(input: { event: StreamEvent }) {
//             return provider.worker.processEvent(input);
//           },
//         },
//       },
//       path: ["projectWorker"],
//     });

//     const response = await caller.projectWorker.fetch(
//       new Request("https://example.com/capability"),
//     );
//     expect(await response.text()).toBe("project worker fetched /capability");
//   });

//   test("provides a project worker ref as a capability", async () => {
//     using providerRoot = connectUnauthenticated();
//     using provider = projectItx(providerRoot);
//     using callerRoot = connectUnauthenticated();
//     using caller = projectItx<ProjectItxRpc & { projectWorkerRef: ProjectWorkerRpc }>(callerRoot);

//     await provider.provideCapability({
//       capability: {
//         type: "dynamic-worker",
//         workerRef: {
//           source: {
//             repoPath: "/repos/project",
//             sourcePath: "worker.js",
//             type: "repo",
//           },
//           target: { type: "worker-entrypoint" },
//         },
//       },
//       path: ["projectWorkerRef"],
//     });

//     const response = await caller.projectWorkerRef.fetch(new Request("https://example.com/ref"));
//     expect(await response.text()).toBe("project worker fetched /ref");
//   });

//   test("invokes dynamic workers that call back through env.ITX.authenticate()", async () => {
//     using providerRoot = connectUnauthenticated();
//     using provider = projectItx(providerRoot);
//     using callerRoot = connectUnauthenticated();
//     using caller = projectItx<ProjectItxRpc & { probe: { repoWhoami(): string } }>(callerRoot);

//     await provider.provideCapability({
//       capability: {
//         type: "dynamic-worker",
//         workerRef: {
//           source: {
//             mainModule: "probe.js",
//             modules: {
//               "probe.js": `
//               import { WorkerEntrypoint } from "cloudflare:workers";
//               export class ProbeEntrypoint extends WorkerEntrypoint {
//                 async repoWhoami() {
//                   const itx = await this.env.ITX.authenticate();
//                   const repo = await itx.repo;
//                   return await repo.whoami();
//                 }
//               }
//             `,
//             },
//             type: "inline",
//           },
//           target: { entrypoint: "ProbeEntrypoint", type: "worker-entrypoint" },
//         },
//       },
//       path: ["probe"],
//     });

//     expect(await caller.probe.repoWhoami()).toBe("repo prj_ref:/repos/project");
//   });

//   test("invokes durable object dynamic capability refs", async () => {
//     using providerRoot = connectUnauthenticated();
//     using provider = projectItx(providerRoot);
//     using callerRoot = connectUnauthenticated();
//     using caller = projectItx<
//       ProjectItxRpc & {
//         counterFacet: { current(): number; increment(): number };
//       }
//     >(callerRoot);
//     const cacheKey = `counter-facet-${crypto.randomUUID()}`;

//     await provider.provideCapability({
//       capability: {
//         type: "dynamic-worker",
//         workerRef: {
//           cacheKey,
//           source: {
//             repoPath: "/repos/project",
//             sourcePath: "worker.js",
//             type: "repo",
//           },
//           target: {
//             className: "CounterDurableObject",
//             type: "durable-object",
//           },
//         },
//       },
//       path: ["counterFacet"],
//     });

//     expect(await caller.counterFacet.increment()).toBe(1);
//     expect(await caller.counterFacet.current()).toBe(1);
//   });
// });
