import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Agent,
  Agents,
  AgentItx,
  CapabilityRecord,
  DynamicWorkerRef,
  DynamicWorkerSource,
  ItxCapabilityHost,
  Json,
  Project,
  ProjectWorker,
  ProvidedCapability,
  Repo,
  Repos,
  RootItx,
  RpcStub,
  RpcTargetImplementation,
  Stream,
  StreamEvent,
  StreamEventInput,
  Streams,
  UnauthenticatedItx,
} from "./types-and-schemas.ts";
import type { ProofConsumedEvent, ProofProcessorState } from "./types-and-schemas.stream-proof.ts";
import {
  ProofCounterContract,
  ProofCounterProcessor,
  ProofStreamDurableObject,
} from "./types-and-schemas.stream-proof.ts";

type IsNever<Value> = [Value] extends [never] ? true : false;
type IsUnknown<Value> = unknown extends Value ? ([Value] extends [unknown] ? true : false) : false;

describe("minimal ITX v3 public types", () => {
  it("keeps the public contract file dependency-free", () => {
    const source = readFileSync(new URL("./types-and-schemas.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toContain('from "zod"');
    expect(source).not.toContain('from "capnweb"');
  });

  it("models the project and agent ITX trees plainly", () => {
    expectTypeOf<UnauthenticatedItx>().toMatchTypeOf<{
      authenticate(input?: unknown): RootItx | Project | AgentItx;
    }>();
    expectTypeOf<Project>().toMatchTypeOf<ItxCapabilityHost>();
    expectTypeOf<Agent>().toMatchTypeOf<ItxCapabilityHost>();
    expectTypeOf<Agent>().toMatchTypeOf<{ itx: AgentItx; stream: Stream }>();
    expectTypeOf<Project>().toMatchTypeOf<{
      streams: Streams;
      agents: Agents;
      repos: Repos;
      repo: Repo;
      worker: ProjectWorker;
      provideCapability: ItxCapabilityHost["provideCapability"];
      revokeCapability: ItxCapabilityHost["revokeCapability"];
      runScript: ItxCapabilityHost["runScript"];
    }>();
    expectTypeOf<AgentItx>().toMatchTypeOf<Project & { agent: Agent }>();
    expectTypeOf<RootItx>().toMatchTypeOf<{ projects: { get(projectId: string): Project } }>();

    if (false) {
      const project = {} as Project;
      const agentItx = {} as AgentItx;

      // @ts-expect-error Project is already the project ITX surface.
      project.project;
      // @ts-expect-error Agent is only present on AgentItx, not on a project ITX.
      project.agent;
      // @ts-expect-error AgentItx keeps project methods at top level; only current agent is extra.
      agentItx.project;
    }
  });

  it("keeps raw stream APIs synchronous for durable object implementations", () => {
    if (false) {
      const stream = {} as Stream;

      expectTypeOf(
        stream.append({ event: { type: "events.iterate.com/demo/one" } }),
      ).toEqualTypeOf<StreamEvent>();
      expectTypeOf(
        stream.appendBatch({ events: [{ type: "events.iterate.com/demo/one" }] }),
      ).toEqualTypeOf<StreamEvent[]>();
      expectTypeOf(stream.getEvents()).toEqualTypeOf<StreamEvent[]>();
    }
  });

  it("lets copied durable objects implement the raw interfaces directly", () => {
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

  it("allows RPC target implementations to forward through async boundaries", () => {
    type StreamTarget = RpcTargetImplementation<Stream>;

    expectTypeOf<Parameters<StreamTarget["append"]>[0]>().toEqualTypeOf<{
      event: StreamEventInput;
    }>();
    expectTypeOf<ReturnType<StreamTarget["append"]>>().toEqualTypeOf<
      StreamEvent | Promise<StreamEvent>
    >();
    expectTypeOf<ReturnType<StreamTarget["appendBatch"]>>().toEqualTypeOf<
      StreamEvent[] | Promise<StreamEvent[]>
    >();
  });

  it("turns the same interfaces into async Cap'n Web stubs", async () => {
    if (false) {
      const project = {} as RpcStub<Project>;
      const streamAppend = project.streams.get("/notes").append({
        event: { type: "events.iterate.com/demo/note-written", payload: { text: "hello" } },
      });
      const batchAppend = project.streams.get("/notes").appendBatch({
        events: [{ type: "events.iterate.com/demo/note-written" }],
      });

      expectTypeOf<IsNever<typeof streamAppend>>().toEqualTypeOf<false>();
      expectTypeOf<IsUnknown<Awaited<typeof streamAppend>>>().toEqualTypeOf<false>();
      expectTypeOf(await streamAppend).toMatchTypeOf<StreamEvent & Disposable>();
      expectTypeOf(await batchAppend).toMatchTypeOf<StreamEvent[] & Disposable>();
      expectTypeOf(await project.repo.whoami()).toEqualTypeOf<string>();
      expectTypeOf(await project.worker.fetch(new Request("https://example.com"))).toEqualTypeOf<
        Response & Disposable
      >();
      expectTypeOf(
        await project.worker.processEvent({
          event: {
            type: "events.iterate.com/demo/note-written",
            offset: 1,
            createdAt: "2026-06-18T12:00:00.000Z",
          },
        }),
      ).toEqualTypeOf<void>();
    }
  });

  it("returns create events and keeps handles on get()", async () => {
    if (false) {
      const repos = {} as Repos;
      const createdRepo = repos.create({ path: "/repos/new" });
      expectTypeOf(createdRepo).toEqualTypeOf<Promise<StreamEvent>>();
      expectTypeOf(repos.get("/repos/new").create()).toEqualTypeOf<Promise<StreamEvent>>();
      expectTypeOf(repos.get("/repos/new").whoami()).toEqualTypeOf<string>();

      const agents = {} as Agents;
      const createdAgent = agents.create({ path: "/agents/new" });
      expectTypeOf(createdAgent).toEqualTypeOf<Promise<StreamEvent>>();
      expectTypeOf(agents.get("/agents/new").create()).toEqualTypeOf<Promise<StreamEvent>>();
      expectTypeOf(agents.get("/agents/new").sendMessage("hello")).toEqualTypeOf<
        Promise<StreamEvent>
      >();

      const project = {} as RpcStub<Project>;
      const repoEvent = await project.repos.create({ path: "/repos/new" });
      expectTypeOf(repoEvent).toMatchTypeOf<StreamEvent & Disposable>();
      // @ts-expect-error create returns a committed event, not a repo handle.
      repoEvent.repo;
      expectTypeOf(await project.repos.get("/repos/new").whoami()).toEqualTypeOf<string>();

      const agentEvent = await project.agents.create({ path: "/agents/new" });
      expectTypeOf(agentEvent).toMatchTypeOf<StreamEvent & Disposable>();
      // @ts-expect-error create returns a committed event, not an agent handle.
      agentEvent.agent;
      expectTypeOf(await project.agents.get("/agents/new").sendMessage("hello")).toMatchTypeOf<
        StreamEvent & Disposable
      >();

      const projectEvent = await project.create();
      expectTypeOf(projectEvent).toMatchTypeOf<StreamEvent & Disposable>();
      // @ts-expect-error create returns a committed event, not a project handle.
      projectEvent.project;

      const root = {} as RpcStub<RootItx>;
      const rootProjectEvent = await root.projects.create("prj_ref");
      expectTypeOf(rootProjectEvent).toMatchTypeOf<StreamEvent & Disposable>();
      // @ts-expect-error create returns a committed event, not a project handle.
      rootProjectEvent.project;
      expectTypeOf(await root.projects.get("prj_ref").repo.whoami()).toEqualTypeOf<string>();
    }
  });

  it("keeps live capabilities out of durable event payloads", () => {
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
          target: { type: "worker-entrypoint" },
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

    void providedCapabilityInput;
    void durableCapabilityInput;
    void invalidCapabilityInput;
    void validEvent;
    void invalidEvent;
  });

  it("keeps stream events generic and JSON-shaped", () => {
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

    expectTypeOf<StreamEvent>().toEqualTypeOf<
      StreamEventInput & {
        createdAt: string;
        offset: number;
      }
    >();

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
    expectTypeOf(
      processor.reduce({
        event: increment,
        state: { count: 0, label: "" },
      }),
    ).toEqualTypeOf<CounterState>();
  });

  it("keeps durable worker refs and capability records explicit", () => {
    expectTypeOf<DynamicWorkerSource>().toEqualTypeOf<
      | { type: "inline"; mainModule: string; modules: Record<string, string> }
      | { type: "repo"; repoPath: string; sourcePath: string }
    >();

    expectTypeOf<DynamicWorkerRef>().toEqualTypeOf<{
      source: DynamicWorkerSource;
      cacheKey?: string;
      target:
        | { type: "worker-entrypoint"; entrypoint?: string; props?: Record<string, Json> }
        | { type: "durable-object"; className: string };
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
      | { type: "live"; path: string[] }
      | { type: "dynamic-worker"; path: string[]; workerRef: DynamicWorkerRef }
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

    void liveCapabilityRecord;
    void dynamicWorkerCapabilityRecord;
    void invalidDynamicWorkerCapabilityRecord;
    void invalidWorkerRef;
  });

  it("types script results as JSON returned across the RPC boundary", async () => {
    if (false) {
      const project = {} as RpcStub<Project>;
      const result = await project.runScript("async () => ({ ok: true })");

      expectTypeOf(result).toMatchTypeOf<
        Awaited<ReturnType<ItxCapabilityHost["runScript"]>> & Disposable
      >();
      expectTypeOf(result.result).toEqualTypeOf<Json>();
      expectTypeOf<IsUnknown<typeof result.result>>().toEqualTypeOf<false>();

      const agent = {} as RpcStub<Agent>;
      const agentResult = await agent.runScript("async () => ({ ok: true })");

      expectTypeOf(agentResult).toMatchTypeOf<
        Awaited<ReturnType<ItxCapabilityHost["runScript"]>> & Disposable
      >();
      expectTypeOf(agentResult.result).toEqualTypeOf<Json>();
    }
  });
});
