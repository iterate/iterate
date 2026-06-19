import { describe, expectTypeOf, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  Agent,
  Agents,
  AgentItx,
  CapabilityRecord,
  DynamicWorkerRef,
  DynamicWorkerSource,
  ItxCapabilityHost,
  Json,
  Repo,
  Repos,
  Project,
  ProjectWorker,
  ProvidedCapability,
  RootItx,
  RootProjects,
  Stream,
  StreamEvent,
  StreamEventInput,
  Streams,
} from "./types-and-schemas.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "./types-and-schemas.ts";
import type { ProofConsumedEvent, ProofProcessorState } from "./types-and-schemas.stream-proof.ts";
import {
  ProofCounterContract,
  ProofCounterProcessor,
  ProofStreamDurableObject,
} from "./types-and-schemas.stream-proof.ts";

describe("minimal ITX public types", () => {
  type LocalProjectWorker = {
    add(a: number, b: number): number;
    greet(name?: string): string;
  };

  it("keeps Project as the real project ITX surface", () => {
    expectTypeOf<Project>().toMatchTypeOf<ItxCapabilityHost>();
    expectTypeOf<Agent>().toMatchTypeOf<ItxCapabilityHost>();
    expectTypeOf<Project>().toMatchTypeOf<{
      streams: Streams;
      agents: Agents;
      repos: Repos;
      provideCapability: ItxCapabilityHost["provideCapability"];
      revokeCapability: ItxCapabilityHost["revokeCapability"];
      runScript: ItxCapabilityHost["runScript"];
    }>();
    expectTypeOf<AgentItx>().toMatchTypeOf<Project & { agent: Agent }>();
    expectTypeOf<RootItx>().toMatchTypeOf<{ projects: RootProjects }>();

    if (false) {
      const itx = {} as AgentItx;
      // @ts-expect-error AgentItx is already the project surface; only the current agent is extra.
      itx.project;
    }
  });

  it("keeps the raw stream API synchronous for server implementations", () => {
    if (false) {
      const stream = {} as Stream;

      expectTypeOf(
        stream.append({
          event: { type: "events.iterate.com/demo/one" },
        }),
      ).toEqualTypeOf<StreamEvent>();

      expectTypeOf(
        stream.appendBatch({
          events: [{ type: "events.iterate.com/demo/one" }],
        }),
      ).toEqualTypeOf<StreamEvent[]>();

      expectTypeOf(stream.getEvents()).toEqualTypeOf<StreamEvent[]>();
    }
  });

  it("lets a copied stream durable object implement the synchronous stream API", () => {
    if (false) {
      const stream = {} as ProofStreamDurableObject;

      expectTypeOf<ProofStreamDurableObject>().toMatchTypeOf<Stream>();
      expectTypeOf(
        stream.append({
          event: { type: "events.iterate.com/proof/increment", payload: { amount: 1 } },
        }),
      ).toEqualTypeOf<StreamEvent>();
      expectTypeOf(
        stream.appendBatch({
          events: [{ type: "events.iterate.com/proof/increment", payload: { amount: 1 } }],
        }),
      ).toEqualTypeOf<StreamEvent[]>();
    }
  });

  it("is directly usable as a Cap'n Web project ITX stub", async () => {
    if (false) {
      const itx = {} as RpcStub<Project>;
      const appendResult = itx.streams.get("/notes").append({
        event: { type: "events.iterate.com/demo/note-written", payload: { text: "hello" } },
      });

      expectTypeOf(appendResult).toMatchTypeOf<Promise<StreamEvent & Disposable>>();

      expectTypeOf(await appendResult).toEqualTypeOf<StreamEvent & Disposable>();

      expectTypeOf(await itx.repo.whoami()).toEqualTypeOf<string>();
      expectTypeOf(await itx.worker.fetch(new Request("https://example.com"))).toEqualTypeOf<
        Response & Disposable
      >();
      expectTypeOf(
        await itx.worker.processEvent({
          event: {
            type: "events.iterate.com/demo/note-written",
            offset: 1,
            createdAt: "2026-06-18T12:00:00.000Z",
          },
        }),
      ).toEqualTypeOf<void>();
      // @ts-expect-error Project ITX is already project-scoped.
      itx.project;
    }
  });

  it("keeps the local reference project worker shape explicit", async () => {
    expectTypeOf<LocalProjectWorker>().not.toMatchTypeOf<ProjectWorker>();

    if (false) {
      const worker = {} as RpcStub<LocalProjectWorker>;

      expectTypeOf(await worker.add(2, 3)).toEqualTypeOf<number>();
      expectTypeOf(await worker.greet("itx")).toEqualTypeOf<string>();
    }
  });

  it("is directly usable as a Cap'n Web agent ITX stub", async () => {
    if (false) {
      const itx = {} as RpcStub<AgentItx>;

      expectTypeOf(await itx.agent.whoami()).toEqualTypeOf<string>();
      expectTypeOf(await itx.repo.whoami()).toEqualTypeOf<string>();
      expectTypeOf(
        await itx.agents.create({ path: "/agents/new" }).agent.whoami(),
      ).toEqualTypeOf<string>();
      expectTypeOf(await itx.agent.stream.getEvents()).toEqualTypeOf<StreamEvent[] & Disposable>();
      expectTypeOf(await itx.agent.sendMessage({ message: "hello" })).toEqualTypeOf<
        StreamEvent & Disposable
      >();

      const projectMount = itx.provideCapability({
        path: ["projectTool"],
        capability: { type: "live", target: {} },
      });
      const agentMount = itx.agent.provideCapability({
        path: ["agentTool"],
        capability: { type: "live", target: {} },
      });

      expectTypeOf(projectMount.revoke()).toMatchTypeOf<Promise<void>>();
      expectTypeOf(agentMount.revoke()).toMatchTypeOf<Promise<void>>();
    }
  });

  it("returns created handles so create calls can be pipelined", async () => {
    if (false) {
      const repos = {} as Repos;
      const createdRepo = repos.create({ path: "/repos/new" });
      expectTypeOf(createdRepo).toEqualTypeOf<{ repo: Repo; event: StreamEvent }>();
      expectTypeOf(createdRepo.repo.create()).toEqualTypeOf<{
        repo: Repo;
        event: StreamEvent;
      }>();
      expectTypeOf(createdRepo.repo.create().repo.whoami()).toEqualTypeOf<string>();
      expectTypeOf(createdRepo.event).toEqualTypeOf<StreamEvent>();

      const agents = {} as Agents;
      const createdAgent = agents.create({ path: "/agents/new" });
      expectTypeOf(createdAgent).toEqualTypeOf<{ agent: Agent; event: StreamEvent }>();
      expectTypeOf(createdAgent.agent.create()).toEqualTypeOf<{
        agent: Agent;
        event: StreamEvent;
      }>();
      expectTypeOf(
        createdAgent.agent.create().agent.sendMessage({ message: "hello" }),
      ).toEqualTypeOf<StreamEvent>();
      expectTypeOf(createdAgent.event).toEqualTypeOf<StreamEvent>();

      const project = {} as RpcStub<Project>;
      expectTypeOf(
        await project.repos.create({ path: "/repos/new" }).repo.whoami(),
      ).toEqualTypeOf<string>();
      expectTypeOf(await project.repos.create({ path: "/repos/new" }).event).toMatchTypeOf<
        StreamEvent & Disposable
      >();
      expectTypeOf(await project.repo.create().repo.whoami()).toEqualTypeOf<string>();
      expectTypeOf(await project.repo.create().event).toMatchTypeOf<StreamEvent & Disposable>();
      expectTypeOf(
        await project.agents
          .create({ path: "/agents/new" })
          .agent.sendMessage({ message: "hello" }),
      ).toEqualTypeOf<StreamEvent & Disposable>();
      expectTypeOf(
        await project.agents.get("/agents/new").create().agent.sendMessage({ message: "hello" }),
      ).toEqualTypeOf<StreamEvent & Disposable>();

      const root = {} as RpcStub<RootItx>;
      expectTypeOf(
        await root.projects.create("prj_ref").project.repo.whoami(),
      ).toEqualTypeOf<string>();
      expectTypeOf(await root.projects.create("prj_ref").event).toMatchTypeOf<
        StreamEvent & Disposable
      >();
      expectTypeOf(
        await root.projects
          .create("prj_ref")
          .project.agents.create({ path: "/agents/new" })
          .agent.whoami(),
      ).toEqualTypeOf<string>();
    }
  });

  it("supports dynamic capability intersections without polluting the base tree", async () => {
    type EchoProject = Project & {
      echo: {
        ping(input: { text: string }): string;
      };
    };

    if (false) {
      const provider = {} as RpcStub<Project>;
      const caller = {} as RpcStub<EchoProject>;

      await provider.provideCapability({
        path: ["echo"],
        capability: {
          type: "live",
          target: {
            ping(input: { text: string }) {
              return `pong:${input.text}`;
            },
          },
        },
      });

      expectTypeOf(await caller.echo.ping({ text: "ok" })).toEqualTypeOf<string>();
      // @ts-expect-error Project ITX has no built-in echo capability.
      provider.echo;
    }
  });

  it("keeps live capabilities separate from durable event payloads", () => {
    expectTypeOf<
      Parameters<Project["provideCapability"]>[0]["capability"]
    >().toEqualTypeOf<ProvidedCapability>();

    const liveCapability = {
      ping(input: { text: string }) {
        return `pong:${input.text}`;
      },
    };

    const providedCapabilityInput = {
      path: ["echo"],
      capability: { type: "live", target: liveCapability },
    } satisfies Parameters<Project["provideCapability"]>[0];

    const providedFunctionCapabilityInput = {
      path: ["compute"],
      capability: {
        type: "live",
        target(input: { value: number }) {
          return input.value + 1;
        },
      },
    } satisfies Parameters<Project["provideCapability"]>[0];

    const providedStubCapabilityInput = {
      path: ["remoteEcho"],
      capability: {
        type: "live",
        target: {} as RpcStub<(input: { text: string }) => string>,
      },
    } satisfies Parameters<Project["provideCapability"]>[0];

    const durableCapabilityInput = {
      path: ["durableEcho"],
      capability: {
        type: "dynamic-worker",
        workerRef: {
          source: {
            type: "inline",
            mainModule: "index.ts",
            modules: { "index.ts": "export default {}" },
          },
          target: {
            type: "worker-entrypoint",
          },
        },
      },
    } satisfies Parameters<Project["provideCapability"]>[0];

    const invalidCapabilityInput = {
      path: ["bad"],
      // @ts-expect-error provided capabilities must use the explicit live/dynamic-worker wrapper.
      capability: "not-a-capability",
    } satisfies Parameters<Project["provideCapability"]>[0];

    const validEvent = {
      type: "events.iterate.com/demo/json",
      payload: { nested: ["ok", 1, true, null] },
    } satisfies StreamEventInput;

    const invalidEvent = {
      type: "events.iterate.com/demo/not-json",
      // @ts-expect-error functions are live capabilities, not durable event payloads.
      payload: { type: "live", target: liveCapability.ping },
    } satisfies StreamEventInput;

    void validEvent;
    void invalidEvent;
    void providedCapabilityInput;
    void providedFunctionCapabilityInput;
    void providedStubCapabilityInput;
    void durableCapabilityInput;
    void invalidCapabilityInput;
  });

  it("keeps stream event schemas simple and JSON-shaped", () => {
    expectTypeOf<StreamEventInput>().toEqualTypeOf<{
      type: string;
      payload?: Json;
      metadata?: Record<string, Json>;
      source?: {
        processor?: {
          slug: string;
          version: string;
        };
      };
      idempotencyKey?: string;
    }>();

    expectTypeOf<StreamEvent>().toMatchTypeOf<{
      type: string;
      payload?: Json;
      metadata?: Record<string, Json>;
      source?: {
        processor?: {
          slug: string;
          version: string;
        };
      };
      idempotencyKey?: string;
      offset: number;
      createdAt: string;
    }>();

    StreamEventInputSchema.parse({
      type: "events.iterate.com/demo/valid",
      payload: { ok: true },
      metadata: { requestId: "req_1" },
    });

    StreamEventSchema.parse({
      type: "events.iterate.com/demo/valid",
      payload: ["ok"],
      offset: 1,
      createdAt: "2026-06-18T12:00:00.000Z",
    });

    const invalidInputWithOffset = {
      type: "events.iterate.com/demo/not-committed-yet",
      // @ts-expect-error offset is assigned by the stream when the event commits.
      offset: 1,
    } satisfies StreamEventInput;

    void invalidInputWithOffset;
  });

  it("narrows copied stream processor contract events by event type", () => {
    type CounterEvent = ProofConsumedEvent<typeof ProofCounterContract>;
    type CounterState = ProofProcessorState<typeof ProofCounterContract>;

    expectTypeOf<CounterState>().toEqualTypeOf<{ count: number; label: string }>();
    expectTypeOf<CounterEvent>().toEqualTypeOf<
      | (Omit<StreamEvent, "payload" | "type"> & {
          payload: { amount: number };
          type: "events.iterate.com/proof/increment";
        })
      | (Omit<StreamEvent, "payload" | "type"> & {
          payload: { text: string };
          type: "events.iterate.com/proof/label";
        })
    >();

    const processor = new ProofCounterProcessor();
    const increment = {
      createdAt: "2026-06-18T12:00:00.000Z",
      offset: 1,
      payload: { amount: 2 },
      type: "events.iterate.com/proof/increment",
    } satisfies CounterEvent;
    const label = {
      createdAt: "2026-06-18T12:00:00.000Z",
      offset: 2,
      payload: { text: "ready" },
      type: "events.iterate.com/proof/label",
    } satisfies CounterEvent;

    const invalidIncrement = {
      createdAt: "2026-06-18T12:00:00.000Z",
      offset: 3,
      payload: {
        // @ts-expect-error increment payload uses amount, not text.
        text: "wrong",
      },
      type: "events.iterate.com/proof/increment",
    } satisfies CounterEvent;

    function assertCounterEventNarrowing(event: CounterEvent) {
      switch (event.type) {
        case "events.iterate.com/proof/increment":
          expectTypeOf(event.payload).toEqualTypeOf<{ amount: number }>();
          break;
        case "events.iterate.com/proof/label":
          expectTypeOf(event.payload).toEqualTypeOf<{ text: string }>();
          break;
        default:
          expectTypeOf(event).toEqualTypeOf<never>();
      }
    }

    assertCounterEventNarrowing(increment);
    assertCounterEventNarrowing(label);

    expectTypeOf(
      processor.reduce({
        event: increment,
        state: { count: 0, label: "" },
      }),
    ).toEqualTypeOf<CounterState>();

    void invalidIncrement;
  });

  it("documents processor-contract support schemas without making them RPC DTOs", () => {
    expectTypeOf<DynamicWorkerSource>().toEqualTypeOf<
      | {
          type: "inline";
          mainModule: string;
          modules: Record<string, string>;
        }
      | {
          type: "repo";
          repoPath: string;
          sourcePath: string;
        }
    >();

    expectTypeOf<DynamicWorkerRef>().toEqualTypeOf<{
      source: DynamicWorkerSource;
      cacheKey?: string;
      target:
        | {
            type: "worker-entrypoint";
            entrypoint?: string;
            props?: Record<string, Json>;
          }
        | {
            type: "durable-object";
            className: string;
          };
    }>();

    const validWorkerRef = {
      source: {
        type: "inline",
        mainModule: "index.ts",
        modules: { "index.ts": "export default {}" },
      },
      target: {
        type: "worker-entrypoint",
        props: { retries: 2, tags: ["demo"] },
      },
    } satisfies DynamicWorkerRef;

    expectTypeOf<CapabilityRecord>().toEqualTypeOf<
      | {
          type: "live";
          path: string[];
        }
      | {
          type: "dynamic-worker";
          path: string[];
          workerRef: DynamicWorkerRef;
        }
    >();

    const liveCapabilityRecord = {
      type: "live",
      path: ["echo"],
    } satisfies CapabilityRecord;

    const dynamicWorkerCapabilityRecord = {
      type: "dynamic-worker",
      path: ["durableEcho"],
      workerRef: validWorkerRef,
    } satisfies CapabilityRecord;

    const invalidDynamicWorkerCapabilityRecord = {
      type: "dynamic-worker",
      path: ["durableEcho"],
      // @ts-expect-error dynamic-worker records must carry the durable worker ref.
    } satisfies CapabilityRecord;

    const invalidWorkerRef = {
      source: {
        type: "inline",
        mainModule: "index.ts",
        modules: { "index.ts": "export default {}" },
      },
      target: {
        type: "worker-entrypoint",
        props: {
          // @ts-expect-error durable capability props are JSON, not live values.
          callback() {
            return "nope";
          },
        },
      },
    } satisfies DynamicWorkerRef;

    void validWorkerRef;
    void liveCapabilityRecord;
    void dynamicWorkerCapabilityRecord;
    void invalidDynamicWorkerCapabilityRecord;
    void invalidWorkerRef;
  });

  it("types script results as serialized data returned across the RPC boundary", async () => {
    if (false) {
      const itx = {} as RpcStub<Project>;
      const result = await itx.runScript({ code: "async () => ({ ok: true })" });

      expectTypeOf(result).toEqualTypeOf<ReturnType<ItxCapabilityHost["runScript"]> & Disposable>();
      expectTypeOf(result.result).toEqualTypeOf<Json>();

      const agent = {} as RpcStub<Agent>;
      const agentResult = await agent.runScript({ code: "async () => ({ ok: true })" });

      expectTypeOf(agentResult).toEqualTypeOf<
        ReturnType<ItxCapabilityHost["runScript"]> & Disposable
      >();
      expectTypeOf(agentResult.result).toEqualTypeOf<Json>();
    }
  });
});
