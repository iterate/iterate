/**
 * Minimal ITX v2 future public contract.
 *
 * This is the one-file tour of the public model the minimal implementation is
 * growing toward.
 *
 * ITX is a project-local capability tree. A client or script starts with one
 * host object, usually `Project`, and walks from there to streams, repos,
 * agents, the default project worker, or dynamically mounted tools.
 *
 * The important thing is that the tree is ordinary TypeScript. Cap'n Web can
 * turn this synchronous interface into an RPC client:
 *
 * ```ts
 * import { newWebSocketRpcSession, type RpcStub } from "capnweb";
 * import type { Project } from "./types-and-schemas";
 *
 * using itx: RpcStub<Project> =
 *   newWebSocketRpcSession<Project>("wss://example.com/api/itx/prj_ref");
 *
 * const note = await itx.streams.get("/notes").append({
 *   event: {
 *     type: "events.iterate.com/demo/note-written",
 *     payload: { text: "hello" },
 *   },
 * });
 * ```
 *
 * Keeping the public interfaces synchronous makes the object model easy to
 * read. Client code can wrap the same type in `RpcStub<T>` and let the
 * transport make calls awaitable and pipeline nested properties.
 *
 * The type names are the nouns a caller sees in the tree: `Project`, `AgentItx`,
 * `Stream`, `Repo`, `Agent`, and so on. Transport stubs are derived from these
 * raw synchronous interfaces.
 *
 * This file intentionally does not duplicate processor-owned event schemas.
 * A stream stores generic facts. Processors own the meaning and payload schema
 * of facts such as `events.iterate.com/repo/created`,
 * `events.iterate.com/agent/message-sent`, or
 * `events.iterate.com/itx/capability-provided`.
 */

import { type RpcPromise, type RpcStub } from "capnweb";
import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ItxAuthCredential = {
  type: "from-server-cookie" | "jwt";
};

/**
 * This is the main module when connecting vi
 */
export interface UnauthenticatedItx {
  authenticate(input: { auth: ItxAuthCredential }): Itx;
}

/**
 * Root of the capability tree
 */
export interface Itx {
  projects: Projects;
}

export interface Projects {
  get(project: string): RpcStub<Project>;

  /**
   * - get DO stub for project with name `{projectId}:/`
   * - stub.create() which appends create-requested event with the creation
   **/
  create(input: {
    id?: string;
    slug: string;
  }): Promise<{ project: Project; createdEvent: StreamEvent }>;

  list(): Promise<{ projects: Project[] }>;
}

/**
 * A project is the stable ITX capability tree for one project.
 *
 * Start here. Everything else in this file explains one branch of this type.
 *
 * - `provideCapability` / `revokeCapability`: mount project-scoped dynamic
 *   capabilities.
 * - `streams`: append to and read generic event streams.
 * - `agents`: create or address agent domain objects by path.
 * - `repos`: create or address repo domain objects by path.
 * - `repo`: convenience handle for the default project repo at
 *   `/repos/project`.
 * - `worker`: the default project worker exported from the default repo.
 */
export interface Project extends ItxCapabilityHost {
  /** Address any stream in the project by path. */
  streams: Streams;

  /** Address or create agent domain objects in the project. */
  agents: Agents;

  /** Address or create repo domain objects in the project. */
  repos: Repos;

  /** Convenience alias for `repos.get("/repos/project")`. */
  repo: Repo;

  /**
   * The default project worker loaded from the project repo.
   *
   * This is a demo worker proving that repo-backed code can be loaded through
   * ITX. Most application-specific workers should be exposed as dynamic
   * capabilities rather than added as new built-ins.
   */
  worker: ProjectWorker;

  // TODO arg shape
  create(): { project: Project; event: StreamEvent };
}

/**
 * When LLM agents write itx scripts or dynamic capabilities, they
 * are given this agent-scoped context.
 *
 * At the moment this is just a shorthand so the agent doesn't need to write
 * itx.agents.get("/agents/some-path") so much
 *
 * Note that it extends Project, so itx.provideCapability() mounts on
 * the project. `itx.agent.provideCapability(...)` mounts on the current agent.
 *
 */
export interface AgentItx extends Project {
  /** Shortcut for the agent domain object that owns this ITX session. */
  agent: Agent;
}

/**
 * Minimal auth model at the public door.
 *
 * Once a request is authorized into a project ITX host, there is no per-branch
 * capability gating in this minimal implementation. Authority is checked at
 * the door: admin reaches all projects; non-admin principals list the project
 * ids they can reach.
 */
export type Access = "all" | string[];

/** Authenticated principal understood by the minimal worker. */
export type Principal = {
  name: string;
  access: Access;
};

/**
 * A stream is an append-only fact log addressed by a project-local path.
 *
 * In minimal ITX the public stream surface is intentionally small. You can:
 *
 * - append one event;
 * - append a batch of events in one ordered commit; and
 * - read committed events by offset range.
 *
 * A stream does not know the application-level meaning of every event. It only
 * gives each event an offset and `createdAt`, stores it durably, and makes it
 * available to processors and readers.
 *
 * ```ts
 * const stream = itx.streams.get("/notes");
 *
 * const committed = await stream.append({
 *   event: {
 *     type: "events.iterate.com/demo/note-written",
 *     payload: { text: "first" },
 *     idempotencyKey: "note:first",
 *   },
 * });
 *
 * const after = await stream.getEvents({ afterOffset: committed.offset - 1 });
 * ```
 */
export interface Stream {
  /**
   * Appends one generic event and returns the committed event with offset and
   * timestamp.
   */
  append(input: { event: StreamEventInput }): StreamEvent;

  /**
   * Appends several events as one ordered operation.
   *
   * The returned array is input-aligned. If an input event has an
   * `idempotencyKey` that already exists, the existing committed event is
   * returned in that slot and no duplicate event is written.
   */
  appendBatch(input: { events: StreamEventInput[] }): StreamEvent[];

  /**
   * Reads events after `afterOffset`, before `beforeOffset`, up to `limit`.
   *
   * Offsets start at 1. `afterOffset: 0` means "from the beginning".
   */
  getEvents(input?: {
    /** Read events strictly after this offset. Use `0` to include the first event. */
    afterOffset?: number;
    /** Read events strictly before this offset. */
    beforeOffset?: number | null;
    /** Maximum number of events to return. */
    limit?: number;
  }): StreamEvent[];

  at(path: string): RpcStub<Stream>;
}

// Utility type to implement the RpcTargetImpl interface
type RpcTargetImpl<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? R extends Promise<any>
      ? T[K]
      : (...args: A) => RpcPromise<R>
    : T[K];
};

// // implementation of the rpc target on the server
// class StreamCapability_ extends RpcTarget implements RpcTargetImpl<Stream> {
//   #stub: RpcStub<Stream>;
//   constructor(readonly path: string) {
//     super();
//   }

//   append(input: { event: StreamEventInput }) {
//     return this.#stub.append(input);
//   }
// }

// class StreamsCapability extends RpcTarget implements Streams {
//   get(path: string): Stream {
//     return new StreamCapability(path);
//   }
// }

// class ProjectCapability extends RpcTarget implements Project {
//   get streams(): Streams {
//     return new StreamsCapability();
//   }
// }

// // client code
// declare const itx: RpcStub<Project>;

// using stream = itx.streams.at("../");
// const commmittedEvent = stream.append({
//   event: { type: "events.iterate.com/demo/note-written", payload: { text: "hello" } },
// });

/**
 * Collection handle for streams.
 *
 * Streams are addressed by leading-slash paths such as `/`, `/notes`, or
 * `/agents/ada`.
 */
export interface Streams {
  /** Returns the stream handle for a project-local path. */
  get(path: string): Stream;
}

/**
 * A repo is an artifact-backed source tree associated with a project path.
 *
 * In the minimal implementation a repo can be created and identified. The
 * default project repo is mounted at `/repos/project` and is also exposed as
 * `itx.repo`.
 */
export interface Repo {
  /** Creates or initializes this repo and returns both the committed fact and repo handle. */
  create(): { repo: Repo; event: StreamEvent };

  /** Returns a human-readable identity string, useful in scripts and tests. */
  whoami(): string;
}

/** Collection handle for repos. */
export interface Repos {
  /** Creates a repo at `input.path` and returns both the committed fact and repo handle. */
  create(input: { path: string }): { repo: Repo; event: StreamEvent };

  /** Returns a repo handle for a project-local path such as `/repos/project`. */
  get(path: string): Repo;
}

/**
 * An agent is a durable actor associated with a project path.
 *
 * The minimal agent can be created, can tell you which agent it is, and can
 * append a message-sent fact to its stream.
 */
export interface Agent extends ItxCapabilityHost {
  /** The stream owned by this agent. */
  stream: Stream;

  /** Creates or initializes this agent and returns both the committed fact and agent handle. */
  create(): { agent: Agent; event: StreamEvent };

  /** Appends an agent message fact and returns the committed event. */
  sendMessage(message: string): StreamEvent;

  /** Returns a human-readable identity string, useful in scripts and tests. */
  whoami(): string;
}

/** Collection handle for agents. */
export interface Agents {
  /** Creates an agent at `input.path` and returns both the committed fact and agent handle. */
  create(input: { path: string }): { agent: Agent; event: StreamEvent };

  /** Returns an agent handle for a project-local path such as `/agents/ada`. */
  get(path: string): Agent;
}

/**
 * The default project worker interface used by project repo code.
 *
 * This is deliberately tiny. It proves that a repo-backed worker can be
 * fetched and can react to stream events; it is not intended to be the
 * universal worker API.
 */
export interface ProjectWorker {
  fetch(req: Request): Response;
  processEvent(input: { event: StreamEvent }): void;
}

/**
 * An ITX object that can mount capabilities and run scripts.
 *
 * The receiver defines where the capability appears:
 * `project.provideCapability(...)` mounts on the project;
 * `agent.provideCapability(...)` mounts on that agent.
 */
export interface ItxCapabilityHost {
  /**
   * Runs code inside a dynamic worker whose environment exposes this ITX host
   * through `env.ITX.authenticate()`.
   *
   * ```ts
   * await itx.runScript({
   *   code: `async (itx) => {
   *     const event = await itx.streams.get("/notes").append({
   *       event: { type: "events.iterate.com/demo/script-ran" },
   *     });
   *     return event.offset;
   *   }`,
   * });
   * ```
   */
  runScript(code: string): {
    completedEvent: StreamEvent;
    executionId: string;
    /** Serializable result returned by the script. */
    result: SerializableObjectTrustMeBro;
  };

  /**
   * Mounts a capability at a JavaScript-like path.
   *
   * `path: ["echo"]` makes `itx.echo` available. `path: ["tools", "math"]`
   * makes `itx.tools.math` available. Calls under that prefix are replayed into
   * the provided capability.
   *
   * ```ts
   * await provider.provideCapability({
   *   path: ["echo"],
   *   capability: {
   *     type: "live",
   *     target: {
   *       ping(input: { text: string }) {
   *         return `pong:${input.text}`;
   *       },
   *     },
   *   },
   * });
   * ```
   */
  provideCapability(input: { path: string[]; capability: ProvidedCapability }): {
    /** Removes this exact mounted capability path. */
    revoke(): void;
  };

  /** Removes a previously mounted capability by exact path. */
  revokeCapability(input: { path: string[] }): void;
}

/**
 * The two legal ways to provide a capability.
 *
 * Live targets can be functions, plain objects, Cap'n Web stubs, Workers RPC
 * stubs, or concrete targets. Dynamic worker refs are JSON-shaped processor
 * state and can be journaled as part of the capability table.
 */
export type ProvidedCapability =
  | { type: "live"; target: unknown }
  | { type: "dynamic-worker"; workerRef: DynamicWorkerRef };

export const SerializableObjectTrustMeBro = z
  .record(z.string(), z.unknown())
  .transform((value) => value as {});
export type SerializableObjectTrustMeBro = z.infer<typeof SerializableObjectTrustMeBro>;

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

/**
 * A generic stream event before it has been committed.
 *
 * This is one of the two generic stream fact schemas. Stream events are the
 * durable data contract; ordinary RPC inputs above are just TypeScript.
 *
 * `type` is a URI-like fact name. ITX uses strings such as
 * `events.iterate.com/demo/note-written`. The stream stores the string but does
 * not validate the payload against that string.
 *
 * `payload` is JSON and intentionally generic. Any domain can append facts, and
 * the processor that owns a fact type validates the payload in its own
 * contract.
 *
 * `metadata` is JSON operational context that should travel with the event but
 * is not part of the domain fact.
 *
 * `source` records a processor identity when an event is emitted by a
 * processor. Ordinary callers usually omit it.
 *
 * `idempotencyKey` makes append retry-safe. Reusing a key returns the original
 * committed event instead of appending a duplicate.
 */
export const StreamEventInput = z.strictObject({
  type: z.string().trim().min(1),
  payload: JsonSchema.optional(),
  metadata: z.record(z.string(), JsonSchema).optional(),
  source: z
    .strictObject({
      processor: z
        .strictObject({
          slug: z.string().trim().min(1),
          version: z.string().trim().min(1),
        })
        .optional(),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type StreamEventInput = z.infer<typeof StreamEventInput>;

/**
 * A stream event after commit.
 *
 * A committed event is exactly the input plus:
 *
 * - `offset`: the stream-local sequence number, starting at 1; and
 * - `createdAt`: an ISO timestamp assigned by the stream.
 */
export const StreamEvent = StreamEventInput.extend({
  offset: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

/**
 * Source code location for a dynamically loaded worker.
 *
 * This is schema-backed because it is nested inside `DynamicWorkerRef`, which
 * the ITX processor contract persists as reduced state.
 */
export const DynamicWorkerSource = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("inline"),
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
  }),
  z.strictObject({
    type: z.literal("repo"),
    repoPath: z.string(),
    sourcePath: z.string(),
  }),
]);
export type DynamicWorkerSource = z.infer<typeof DynamicWorkerSource>;

/**
 * Durable worker reference for a capability that can be reloaded after eviction.
 *
 * This is schema-backed because the ITX processor contract stores worker refs
 * in reduced state. `props` is JSON because a durable worker ref is persisted
 * state, not a live Workers binding or Cap'n Web stub.
 */
export const DynamicWorkerRef = z.strictObject({
  source: DynamicWorkerSource,
  cacheKey: z.string().optional(),
  target: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("worker-entrypoint"),
      entrypoint: z.string().optional(),
      props: SerializableObjectTrustMeBro.optional(),
    }),
    z.strictObject({
      type: z.literal("durable-object"),
      className: z.string(),
    }),
  ]),
});
export type DynamicWorkerRef = z.infer<typeof DynamicWorkerRef>;

/**
 * One row in the ITX processor's dynamic capability table.
 *
 * Live capabilities are retained in memory by the current processor
 * incarnation. Dynamic worker capabilities store a durable `DynamicWorkerRef`
 * and can be reloaded after eviction.
 */
export const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("live"),
    path: z.array(z.string()),
  }),
  z.strictObject({
    type: z.literal("dynamic-worker"),
    path: z.array(z.string()),
    workerRef: DynamicWorkerRef,
  }),
]);
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

// In this file - only have types
// Then have expect type that guarantees stream processor zod land aligns with types in these helper functions
