import http from "node:http";
import { describe, expect, test } from "vitest";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- this regression test intentionally proves the one-shot HTTP batch shape.
import { newHttpBatchRpcSession } from "capnweb";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { buildUrl, withItxSession } from "./test-helpers.ts";
import type { ItxWebSocketMessage } from "./test-helpers.ts";
import type { UnauthenticatedItx } from "./types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";
import { RepoArtifactNameCodec } from "./src/domains/repos/repo-artifact-name.ts";
import {
  StreamProcessor,
  type StreamProcessorSnapshot,
} from "./src/domains/streams/engine/stream-processor.ts";

type MockSlack = {
  calls: string[];
  close(): Promise<void>;
  url: string;
};

type PathCallable = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
};

const PROJECT_WORKER_FORWARDED_EVENT_TYPE = "events.iterate.test/project-worker-forwarded";

const ProjectWorkerForwardingProbeContract = defineProcessorContract({
  slug: "minimal-itx-v4.project-worker-forwarding-probe",
  version: "0.1.0",
  description: "Records project worker processEvent deliveries observed through an ITX stream.",
  stateSchema: z.object({
    childPaths: z.array(z.string()).default([]),
    markers: z.array(z.string()).default([]),
  }),
  initialState: { childPaths: [], markers: [] },
  events: {
    [PROJECT_WORKER_FORWARDED_EVENT_TYPE]: {
      payloadSchema: z.object({
        childPath: z.string(),
        marker: z.string(),
        originalType: z.string(),
      }),
    },
  },
  consumes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
  emits: [],
});
type ProjectWorkerForwardingProbeContract = typeof ProjectWorkerForwardingProbeContract;
type ProjectWorkerForwardingProbeState = {
  childPaths: string[];
  markers: string[];
};

class ProjectWorkerForwardingProbeProcessor extends StreamProcessor<ProjectWorkerForwardingProbeContract> {
  readonly contract = ProjectWorkerForwardingProbeContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<ProjectWorkerForwardingProbeContract>["reduce"]>[0]) {
    return {
      childPaths: [...state.childPaths, event.payload.childPath],
      markers: [...state.markers, event.payload.marker],
    };
  }
}

function parseBody(body: string, contentType: string | string[] | undefined): Record<string, any> {
  if (typeof contentType === "string" && contentType.includes("application/json")) {
    try {
      return JSON.parse(body) as Record<string, any>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function startMockSlack(): Promise<MockSlack> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const method = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    calls.push(method);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = parseBody(body, req.headers["content-type"]);
      res.setHeader("content-type", "application/json");
      if (method === "chat.postMessage") {
        res.end(
          JSON.stringify({
            ok: true,
            channel: payload.channel,
            ts: "1718000000.000100",
            message: { text: payload.text, type: "message" },
            via: "mock-slack-api",
          }),
        );
        return;
      }
      if (method === "users.list") {
        res.end(
          JSON.stringify({
            ok: true,
            members: [
              { id: "U1", name: "ada" },
              { id: "U2", name: "grace" },
            ],
            via: "mock-slack-api",
          }),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, via: "mock-slack-api" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        calls,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        url: `http://127.0.0.1:${port}/`,
      });
    });
  });
}

function pathCallable(target: unknown): PathCallable {
  return {
    invokeCapability({ args = [], path }) {
      if (path.length === 0) return target;

      let receiver = target;
      for (const segment of path.slice(0, -1)) {
        if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
          throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
        }
        receiver = Reflect.get(receiver, segment);
      }

      const method = path.at(-1)!;
      if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
        throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
      }
      const callable = Reflect.get(receiver, method);
      if (typeof callable !== "function") {
        throw new Error(`path "${path.join(".")}" did not resolve to a function`);
      }
      return Reflect.apply(callable, receiver, args);
    },
  };
}

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

  test("Authenticated internal auth itx can create project and append to stream", async () => {
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

    // TODO project slug should be derived from tests etc as in apps/os
    using project = itx.projects.create({ slug: "alice-project" });
    const description = await project.describe();
    expect(description.projectId).toMatch(/prj_[0-9a-f-]+$/);
    expect(description.name).toMatch(/prj_[0-9a-f-]+\.iterate\/$/);
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
        "events.iterate.com/repo/create-requested",
        "events.iterate.com/repo/created",
        "events.iterate.com/project/created",
        "events.iterate.com/stream/subscriber-disconnected",
      ]),
    );

    const repoCreated = events.find((event) => event.type === "events.iterate.com/repo/created");
    const projectCreated = events.find(
      (event) => event.type === "events.iterate.com/project/created",
    );
    expect(repoCreated).toMatchObject({
      payload: {
        artifactName: RepoArtifactNameCodec.stringify({
          path: "/",
          projectId: description.projectId,
        }),
        path: "/",
        projectId: description.projectId,
      },
    });
    expect(projectCreated).toBeTruthy();
    expect(repoCreated!.offset).toBeLessThan(projectCreated!.offset);

    expect(await project.repo.whoami()).toBe(`repo ${description.projectId}:/`);
    expect(await project.repos.get("/").whoami()).toBe(`repo ${description.projectId}:/`);

    const workerResponse = await project.worker.fetch(new Request("https://example.com/probe"));
    expect(await workerResponse.text()).toBe("project worker fetched /probe");

    const [committedEvent] = await project.streams.get("/some/path").append({
      type: "hello-world",
    });
    expect(committedEvent).toMatchObject({
      type: "hello-world",
      offset: 3, // first two events are created and woken
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
          getSecret: (secretGetter: () => Promise<string>) => secretGetter(),
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

  test("Project repos, workers, runScript, and dynamic worker refs compose", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "dynamic-worker-project" });
    const description = await project.describe();

    const scriptResult = await project.runScript(`async (itx) => {
      const response = await itx.worker.fetch(new Request("https://example.com/script"));
      return {
        repo: await itx.repo.whoami(),
        worker: await response.text(),
      };
    }`);
    expect(scriptResult.result).toEqual({
      repo: `repo ${description.projectId}:/`,
      worker: "project worker fetched /script",
    });

    const commit = await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`updated project worker fetched \${new URL(req.url).pathname}\`);
              }

              someMethod() {
                return {
                  projectId: ${JSON.stringify(description.projectId)},
                  source: "committed-worker",
                };
              }

              processEvent(input) {
                console.log("updated project worker processed", input.event.type);
              }
            }

            export class CounterDurableObject extends DurableObject {
              async increment() {
                const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
                await this.ctx.storage.put("n", n);
                return n;
              }

              async current() {
                return (await this.ctx.storage.get("n")) ?? 0;
              }
            }
          `,
        },
      ],
      message: "Add someMethod to project worker",
    });
    expect(commit).toMatchObject({
      branch: "main",
      changedPaths: ["worker.js"],
      noChanges: false,
    });
    expect(commit.commitOid).toMatch(/^[0-9a-f]{40}$/);
    // @ts-expect-error - dynamic project worker method from committed source
    expect(await project.worker.someMethod()).toEqual({
      projectId: description.projectId,
      source: "committed-worker",
    });

    await project.provideCapability({
      path: ["probe"],
      capability: {
        type: "dynamic-worker",
        workerRef: {
          source: {
            mainModule: "probe.js",
            modules: {
              "probe.js": `
                import { WorkerEntrypoint } from "cloudflare:workers";

                export class ProbeEntrypoint extends WorkerEntrypoint {
                  async inspect() {
                    const root = await this.env.ITX.authenticate();
                    const repo = await this.env.ITX.projectRepo(${JSON.stringify(description.projectId)});
                    return {
                      principal: await root.whoami(),
                      repo: await repo.whoami(),
                    };
                  }
                }
              `,
            },
            type: "inline",
          },
          target: { entrypoint: "ProbeEntrypoint", type: "worker-entrypoint" },
        },
      },
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.probe.inspect()).toEqual({
      principal: "trusted-internal",
      repo: `repo ${description.projectId}:/`,
    });

    await project.provideCapability({
      path: ["projectWorkerRef"],
      capability: {
        type: "dynamic-worker",
        workerRef: {
          source: {
            repoPath: "/",
            sourcePath: "worker.js",
            type: "repo",
          },
          target: { type: "worker-entrypoint" },
        },
      },
    });
    // @ts-expect-error - dynamic capability root
    const workerRefResponse = await project.projectWorkerRef.fetch(
      new Request("https://example.com/ref"),
    );
    expect(await workerRefResponse.text()).toBe("updated project worker fetched /ref");

    await project.provideCapability({
      path: ["counterFacet"],
      capability: {
        type: "dynamic-worker",
        workerRef: {
          cacheKey: `counter-facet-${crypto.randomUUID()}`,
          source: {
            repoPath: "/",
            sourcePath: "worker.js",
            type: "repo",
          },
          target: {
            className: "CounterDurableObject",
            type: "durable-object",
          },
        },
      },
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.counterFacet.increment()).toBe(1);
    // @ts-expect-error - dynamic capability root
    expect(await project.counterFacet.current()).toBe(1);
  });

  test("Dynamic project worker processEvent can cross-post project events", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "project-worker-process-event" });
    const description = await project.describe();
    const marker = `cross-post-${crypto.randomUUID()}`;

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() {
                return new Response("ok");
              }

              async processEvent({ event }) {
                if (event.metadata?.crossPostMarker !== ${JSON.stringify(marker)}) return;

                const root = await this.env.ITX.authenticate(this.ctx.props.auth);
                // TODO(workers-rpc-pipelining): This should eventually collapse to
                // root.projects.get(this.ctx.props.projectId).streams.get(...).
                // Workers RPC exposes prototype getters, but workerd does not reliably
                // promise-pipeline through getter/property hops on an unresolved RPC
                // result. That is why apps/os uses method-shaped boundaries like
                // node.itx().invoke(...) and PathProxy/replayPathCall for deep dotted
                // traversal. Keep this explicit await until v4 has the same kind of
                // method-shaped or path-proxy bridge for project-scoped ITX handles.
                const project = await root.projects.get(this.ctx.props.projectId);
                await project.streams.get("/cross-posted").append({
                  type: "events.iterate.com/test/cross-posted",
                  idempotencyKey: \`project-worker-cross-post:\${event.offset}\`,
                  metadata: {
                    crossPostedBy: "project-worker",
                    marker: event.metadata.crossPostMarker,
                    sourceOffset: event.offset,
                  },
                  payload: {
                    originalPayload: event.payload ?? null,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
        },
      ],
      message: "Cross-post selected project events from processEvent",
    });

    const crossPosted = project.streams.get("/cross-posted");
    const copied = crossPosted.waitForEvent({
      eventTypes: ["events.iterate.com/test/cross-posted"],
      timeoutMs: 30_000,
    });

    const [sourceEvent] = await project.streams.get("/").append({
      type: "events.iterate.com/test/source",
      metadata: { crossPostMarker: marker },
      payload: { text: "hello from root" },
    });

    const copiedEvent = await copied;
    expect(copiedEvent.metadata).toMatchObject({
      crossPostedBy: "project-worker",
      marker,
      sourceOffset: sourceEvent.offset,
    });
    expect(copiedEvent.payload).toEqual({
      originalPayload: { text: "hello from root" },
      originalType: "events.iterate.com/test/source",
    });
  });

  test("Project stream subscribe can observe project worker processEvent forwarding", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    const marker = crypto.randomUUID();
    const outputPath = `/worker-forwarding-output-${marker}`;
    const triggerPath = `/worker-forwarding-trigger-${marker}`;

    using project = itx.projects.create({ slug: `worker-forwarding-${marker}` });
    const description = await project.describe();

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const TRIGGER_PATH = ${JSON.stringify(triggerPath)};
            const MARKER = ${JSON.stringify(marker)};
            const FORWARDED_EVENT_TYPE = ${JSON.stringify(PROJECT_WORKER_FORWARDED_EVENT_TYPE)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`forwarding test worker fetched \${new URL(req.url).pathname}\`);
              }

              async processEvent(input) {
                const event = input.event;
                if (event.type !== "events.iterate.com/stream/child-stream-created") return;
                if (event.payload.childPath !== TRIGGER_PATH) return;

                const root = await this.env.ITX.authenticate(this.ctx.props.auth);
                // TODO(workers-rpc-pipelining): This should eventually collapse to
                // root.projects.get(this.ctx.props.projectId).streams.get(...).
                // Workers RPC exposes prototype getters, but workerd does not reliably
                // promise-pipeline through getter/property hops on an unresolved RPC
                // result. That is why apps/os uses method-shaped boundaries like
                // node.itx().invoke(...) and PathProxy/replayPathCall for deep dotted
                // traversal. Keep this explicit await until v4 has the same kind of
                // method-shaped or path-proxy bridge for project-scoped ITX handles.
                const project = await root.projects.get(this.ctx.props.projectId);
                await project.streams.get(OUTPUT_PATH).append({
                  type: FORWARDED_EVENT_TYPE,
                  payload: {
                    childPath: event.payload.childPath,
                    marker: MARKER,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
        },
      ],
      message: "Add forwarding test worker",
    });

    const outputStream = project.streams.get(outputPath);
    let storedSnapshot: StreamProcessorSnapshot<ProjectWorkerForwardingProbeState> | undefined;
    const processor = new ProjectWorkerForwardingProbeProcessor({
      readState: () => storedSnapshot,
      stream: outputStream as never,
      writeState: (snapshot) => {
        storedSnapshot = snapshot;
      },
    });

    const initial = await processor.snapshot();
    const subscription = await outputStream.subscribe({
      eventTypes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
      processEventBatch: (batch) => processor.ingest(batch),
      replayAfterOffset: initial.offset,
      subscriber: {
        description: "minimal-itx-v4 e2e local project worker forwarding probe",
      },
    });

    await project.streams.get(triggerPath).append({
      type: "events.iterate.test/project-worker-forwarding-trigger",
      payload: { marker },
    });

    await processor.waitUntilEvent({
      predicate: (event) =>
        event.type === PROJECT_WORKER_FORWARDED_EVENT_TYPE && event.payload?.marker === marker,
      timeoutMs: 8_000,
    });
    expect(processor.state).toEqual({
      childPaths: [triggerPath],
      markers: [marker],
    });
    expect(storedSnapshot).toEqual({
      offset: expect.any(Number),
      state: {
        childPaths: [triggerPath],
        markers: [marker],
      },
    });

    await subscription.unsubscribe();
    const stateAtUnsubscribe = processor.state;
    await outputStream.append({
      type: PROJECT_WORKER_FORWARDED_EVENT_TYPE,
      payload: {
        childPath: outputPath,
        marker: `after-${marker}`,
        originalType: "manual",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(processor.state).toEqual(stateAtUnsubscribe);
  });

  test("Authenticated project can provide the Slack SDK as nested dotted callables", async () => {
    const mock = await startMockSlack();
    try {
      using session = withItxSession();
      using itx = session.authenticate({
        type: "trusted-internal",
        token: TRUSTED_INTERNAL_ITX_TOKEN,
      });

      using project = itx.projects.create({ slug: "slack-project" });
      const description = await project.describe();

      const slack = new WebClient("xoxb-not-a-real-token", {
        retryConfig: { retries: 0 },
        slackApiUrl: mock.url,
      });

      const { revoke } = await project.provideCapability({
        path: ["slack"],
        capability: {
          type: "live",
          target: pathCallable(slack),
        },
      });

      using callerSession = withItxSession();
      using callerItx = callerSession.authenticate({
        type: "token",
        token: {
          projectScopes: [description.projectId],
          type: "user",
          principal: "alice",
        },
      });
      const callerProject = callerItx.projects.get(description.projectId);

      // @ts-expect-error - dynamic capability root
      const posted = await callerProject.slack.chat.postMessage({
        channel: "C123",
        text: "hi from itx",
      });
      expect(posted).toMatchObject({
        channel: "C123",
        message: { text: "hi from itx" },
        ok: true,
        via: "mock-slack-api",
      });

      // @ts-expect-error - dynamic capability root
      const users = await callerProject.slack.users.list();
      expect(users).toMatchObject({
        members: [
          { id: "U1", name: "ada" },
          { id: "U2", name: "grace" },
        ],
        ok: true,
        via: "mock-slack-api",
      });
      expect(mock.calls).toEqual(expect.arrayContaining(["chat.postMessage", "users.list"]));

      await revoke();
      await expect(
        // @ts-expect-error - dynamic capability root
        callerProject.slack.chat.postMessage({ channel: "C123", text: "after revoke" }),
      ).rejects.toThrow(/no capability "slack.chat.postMessage"/);
    } finally {
      await mock.close();
    }
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
