/**
 * Minimal ITX v4 public contract.
 *
 * This is the one file a caller should need to understand the model.
 *
 * ITX is a project-local capability tree. A caller first receives an
 * `UnauthenticatedItx`, calls `authenticate(...)`, and then walks ordinary
 * TypeScript objects: projects, streams, repos, agents, the project worker, and
 * any dynamic capabilities mounted at runtime.
 *
 * This file describes the ITX capability tree as target objects: the methods a
 * worker, Durable Object, or RpcTarget exposes. A caller that receives a remote
 * capability should use `RpcStub<UnauthenticatedItx>` or `RpcStub<ItxRoot>`;
 * the `RpcStub<T>` helper near the bottom of this file turns these target
 * methods into Workers/Cap'n Web RPC promises and preserves pipelining.
 *
 * Do not read a synchronous method here as "remote calls are synchronous".
 * Cloudflare Workers RPC and Durable Object stubs make every RPC call
 * asynchronous on the caller side, even when the target method is synchronous:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/#all-calls-are-asynchronous
 * https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/#invoke-rpc-methods
 *
 * Stream append and committed-event reads are deliberately synchronous at the
 * Stream Durable Object implementation. The stream owns the append transaction:
 * it assigns offsets, persists rows, updates reduced state, and only then
 * starts post-commit fan-out. `StreamDurableObject implements Stream`, so the
 * `Stream` method signatures are the local implementation guard for that rule.
 *
 * ```ts
 * using unauthenticated = connect<UnauthenticatedItx>(itxWebSocketUrl);
 * using itx = unauthenticated.authenticate({
 *   auth: {
 *     type: "token",
 *     token: { type: "user", principal: "alice", projectScopes: ["prj_ref"] },
 *   },
 *   projectId: "prj_ref",
 * });
 *
 * const event = await itx.streams.get("/notes").append({
 *   event: {
 *     type: "events.iterate.com/demo/note-written",
 *     payload: { text: "hello" },
 *   },
 * });
 * ```
 */

export interface UnauthenticatedItx {
  /**
   * Authenticates into the requested ITX host.
   *
   * - omit `projectId` to get the root ITX catalog;
   * - pass `projectId` to get that project;
   * - pass an agent path such as `/agents/ada` to get an `AgentItx`.
   *
   * Dynamic workers can omit `input` when the platform-provided binding already
   * carries trusted connection props.
   */
  authenticate(input: ItxAuthCredentials): ItxRoot;
}

export interface ItxRoot {
  projects: Projects;
  whoami(): string;
}

export interface Projects {
  get(projectId: string): Promise<Project>;
  create(args: { projectId: string; slug: string }): Promise<Project>;
  list(): Promise<string[]>;
}

/**
 * A project is the stable ITX capability tree for one project.
 *
 * `provideCapability` and `revokeCapability` mount project-scoped dynamic
 * capabilities. Domain handles (`streams`, `repos`, `agents`, `repo`, and
 * `worker`) are built-ins and cannot be shadowed by dynamic capabilities.
 */
export interface Project extends ItxCapabilityHost {
  streams: Streams;
  // agents: Agents;
  // repos: Repos;
  // repo: Repo;
  // worker: ProjectWorker;
  create(args: { projectId?: string; slug: string }): Promise<StreamEvent>;
}

/**
 * Agent-scoped scripts still see the project surface at top level.
 *
 * `itx.provideCapability(...)` mounts on the project. `itx.agent` is the
 * explicit handle for the current agent, so `itx.agent.provideCapability(...)`
 * mounts on that agent instead.
 */
export interface AgentItx extends Project {
  agent: Agent;
}

/**
 * A stream is an append-only event log plus the small live runtime surface that
 * processors and callers use to read, wait, and subscribe.
 *
 * These are target-side method signatures, not client-side stub signatures.
 * For remote code, use `RpcStub<Stream>` or a containing `RpcStub<ItxRoot>`.
 * Workers RPC turns even synchronous target methods into awaitable thenables,
 * and those thenables are also stubs so calls can be pipelined:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining
 *
 * The synchronous append/read signatures are intentional. `StreamDurableObject`
 * implements this whole interface, so changing `append`, `appendBatch`,
 * `getEvent`, or `getEvents` to return a Promise fails at the class declaration.
 * SQLite-backed Durable Objects provide synchronous SQL and synchronous KV
 * APIs, and Cloudflare documents that SQL cursors should be consumed before the
 * next `await`:
 * https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec
 * https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api
 */
export interface Stream {
  /** Append one event to this stream, or to a child/relative stream path. */
  append(input: { streamPath?: string; event: StreamEventInput }): StreamEvent;

  /** Append several events atomically, preserving input order. */
  appendBatch(input: { streamPath?: string; events: StreamEventInput[] }): StreamEvent[];

  /**
   * Read one committed event by offset or idempotency key.
   *
   * Offsets are the stream's durable replay cursor. Idempotency keys are the
   * caller-provided write de-duplication keys. Exactly one selector should be
   * present.
   */
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined;

  /** Read committed events by offset range, in ascending offset order. */
  getEvents(input?: {
    /** Return only events with an offset strictly greater than this value. */
    afterOffset?: number;
    /** Return only events with an offset strictly less than this value. */
    beforeOffset?: number | null;
    /** Maximum number of events to return. */
    limit?: number;
  }): StreamEvent[];

  /** Resolve when a committed event matches the supplied predicate. */
  waitForEvent(input: {
    /** Start after this offset. Omit to wait from the current live edge. */
    afterOffset?: number;
    /** Optional event-type prefilter. Omit, or include `"*"`, for all events. */
    eventTypes?: readonly string[];
    /** Called for candidate events until it returns true. */
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    /** Maximum time to wait before rejecting. */
    timeoutMs: number;
  }): Promise<StreamEvent>;

  /**
   * Inspect the hosted processor attached to a subscription, when present.
   *
   * This may call a live processor/subscriber capability and is not part of the
   * stream's synchronous append/read storage boundary.
   */
  getProcessorRuntimeState(input: { subscriptionKey: string }): Promise<{
    /** Durable checkpoint for the hosted processor. */
    snapshot: {
      offset: number;
      state: unknown;
    };
    /** Optional live runtime details exposed by the processor. */
    runtime?: Record<string, unknown>;
  } | null>;

  /** Inspect the stream's current core state and live connection roster. */
  runtimeState(): {
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  };

  /** Abort the current Durable Object incarnation. Used by tests/debug tools. */
  kill(): void;

  /** Subscribe to catch-up and live event delivery. */
  subscribe(input: {
    /**
     * Stable subscriber identity. Omit to let the stream generate one. Calling
     * subscribe() twice with the same subscriptionKey replaces the old
     * subscription.
     */
    subscriptionKey?: string;
    /** Receives each replay/live delivery batch. */
    processEventBatch: (batch: {
      /** Project that owns the stream; root streams may use `null`. */
      projectId: string | null;
      /** Canonical stream path, such as `/` or `/agents/ada`. */
      path: string;
      /** Committed events delivered in stream offset order. */
      events: StreamEvent[];
      /** Highest committed offset known when the batch was delivered. */
      streamMaxOffset: number;
      /** Stream runtime state snapshot carried with the batch. */
      state: unknown;
    }) => unknown;
    /** Replay events after this offset before switching to live delivery. */
    replayAfterOffset?: number;
    /** Optional event-type filter. Omit, or include `"*"`, for all events. */
    eventTypes?: readonly string[];
    /**
     * `false` requests state-only delivery: batches contain `events: []`, replay
     * is skipped, and live state advances may be coalesced.
     */
    events?: boolean;
    /** Serializable subscriber metadata recorded in stream presence state. */
    subscriber?: unknown;
  }): {
    /** Stable key assigned to this subscription. */
    subscriptionKey: string;
    /** Highest committed offset known when the subscription opened. */
    streamMaxOffset: number;
    /** Stops delivery for this subscription. */
    unsubscribe(): void;
  };
}

export interface Streams {
  get(path: string): Stream;
}

export interface Repo {
  create(): Promise<StreamEvent>;
  whoami(): string;
}

export interface Repos {
  create(input: { path: string }): Promise<StreamEvent>;
  get(path: string): Repo;
}

export interface Agent extends ItxCapabilityHost {
  itx: AgentItx;
  stream: Stream;

  create(): Promise<StreamEvent>;
  sendMessage(message: string): Promise<StreamEvent>;
  whoami(): string;
}

export interface Agents {
  create(input: { path: string }): Promise<StreamEvent>;
  get(path: string): Agent;
}

export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  processEvent(input: { event: StreamEvent }): void | Promise<void>;
}

export interface ItxCapabilityHost {
  runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: JsonSerializableTrustMeBro;
  }>;

  provideCapability(input: { path: string[]; capability: ProvidedCapability }): Promise<{
    revoke(): void | Promise<void>;
  }>;

  revokeCapability(input: { path: string[] }): void | Promise<void>;
}

/**
 * Live capabilities are runtime-only arguments and may contain stubs or local
 * objects. Dynamic worker refs are JSON-shaped so the ITX processor can journal
 * and reload them after eviction.
 */
export type ProvidedCapability =
  | { type: "live"; target: unknown }
  | { type: "dynamic-worker"; workerRef: DynamicWorkerRef };

export type DynamicWorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      sourcePath: string;
    };

export type DynamicWorkerRef = {
  source: DynamicWorkerSource;
  cacheKey?: string;
  target:
    | {
        type: "worker-entrypoint";
        entrypoint?: string;
        props?: Record<string, JsonSerializableTrustMeBro>;
      }
    | {
        type: "durable-object";
        className: string;
      };
};

export type CapabilityRecord =
  | {
      type: "live";
      path: string[];
    }
  | {
      type: "dynamic-worker";
      path: string[];
      workerRef: DynamicWorkerRef;
    };

export type StreamEventInput = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: {
    processor?: {
      slug: string;
      version: string;
    };
  };
  idempotencyKey?: string;
};

export type StreamEvent = StreamEventInput & {
  createdAt: string;
  offset: number;
};

/** Opaque by-value RPC payload. Runtime code is responsible for serializability. */
export type JsonSerializableTrustMeBro = {} | null;

/**
 * ITX interfaces that are passed by reference as nested capabilities.
 *
 * Workers RPC and Cap'n Web both model object-capability RPC: a class extending
 * `RpcTarget`, a WorkerEntrypoint, or a Durable Object is not serialized as
 * plain data. The recipient gets a stub and can pipeline calls on that stub.
 *
 * `RpcTargetImplementation<T>` uses this list to distinguish two cases:
 *
 * - capability-shaped results, such as `Streams.get(): Stream`, may be
 *   implemented by returning another local `RpcTargetImplementation<Stream>`
 *   object like `new StreamRpcTarget(...)`;
 * - ordinary data results, such as `StreamEvent`, must still be returned as
 *   data, not as nested RPC target implementations.
 *
 * When adding a new pass-by-reference ITX capability interface, add it here.
 * Do not add by-value payload types to this union.
 *
 * References:
 * - Workers RPC class instances / RpcTarget pass by reference:
 *   https://developers.cloudflare.com/workers/runtime-apis/rpc/#class-instances
 * - Workers RPC promise pipelining:
 *   https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining
 * - Cap'n Web interoperability with Workers RPC:
 *   https://github.com/cloudflare/capnweb#cloudflare-workers-rpc-interoperability
 */
type RpcTargetCapability =
  | UnauthenticatedItx
  | ItxRoot
  | Projects
  | Project
  | AgentItx
  | Stream
  | Streams
  | Repo
  | Repos
  | Agent
  | Agents
  | ProjectWorker
  | ItxCapabilityHost;

type RpcTargetResult<T> =
  | T
  | Promise<T>
  | (T extends RpcTargetCapability ? RpcTargetImplementation<T> : never)
  | (T extends RpcTargetCapability ? Promise<RpcTargetImplementation<T>> : never);

/**
 * Server-side implementation shape for an RpcTarget adapter.
 *
 * This is intentionally not the same as `T`.
 *
 * A public target interface such as `Stream` describes what the capability
 * logically exposes. An adapter class such as `StreamRpcTarget` is allowed to
 * implement that capability by forwarding to a Durable Object stub. Cloudflare
 * documents those stub calls as asynchronous on the caller side, and nested
 * capability returns must stay pass-by-reference so callers can pipeline:
 *
 * ```ts
 * const stream = itx.projects.get("prj").streams.get("/notes");
 * const event = await stream.append({ event: { type: "note" } });
 * ```
 *
 * Therefore this helper permits two adapter-only freedoms:
 *
 * - any method/property may return `Promise<Awaited<Result>>`, because RPC
 *   forwarding is asynchronous even when the target method is synchronous;
 * - methods/properties whose result is another ITX capability may return a
 *   nested `RpcTargetImplementation<Result>` instead of a plain data object.
 *
 * Do not use this type to guard Durable Object storage methods that must remain
 * synchronous. `StreamDurableObject implements Stream` is the local invariant;
 * this helper is only for RpcTarget adapter classes.
 */
export type RpcTargetImplementation<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => RpcTargetResult<Awaited<Result>>
    : RpcTargetResult<T[K]>;
};

/**
 * Credentials passed by a capnweb client to the stateless worker in worker.ts to authenticate.
 *
 * - `from-server-cookie` tells worker.ts "take the cookie from the http request and use it"
 * - `token` lets you pass in an auth token directly
 * - `trusted-internal` is used for internal callers (e.g. a dynamic worker)
 */
export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "token"; token: ItxAuthToken }
  | { type: "trusted-internal"; token: string };

export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
}

// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// The following Cap'n Web type helpers are copied from capnweb's public types
// so this contract file has no imports. Keep them at the bottom: they describe
// transport behavior, while the ITX model above is the actual domain contract.

export declare const __RPC_STUB_BRAND: "__RPC_STUB_BRAND";
export declare const __RPC_TARGET_BRAND: "__RPC_TARGET_BRAND";
declare const __RPC_MAP_VALUE_BRAND: unique symbol;

export interface RpcTargetBranded {
  [__RPC_TARGET_BRAND]: never;
}

export type Stubable = RpcTargetBranded | ((...args: never[]) => unknown);

type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;

export type RpcCompatible<T> =
  | (IsUnknown<T> extends true ? unknown : never)
  | BaseType
  | Map<
      T extends Map<infer U, unknown> ? RpcCompatible<U> : never,
      T extends Map<unknown, infer U> ? RpcCompatible<U> : never
    >
  | Set<T extends Set<infer U> ? RpcCompatible<U> : never>
  | Array<T extends Array<infer U> ? RpcCompatible<U> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer U> ? RpcCompatible<U> : never>
  | {
      [K in keyof T as K extends string | number ? K : never]: RpcCompatible<T[K]>;
    }
  | Promise<T extends Promise<infer U> ? RpcCompatible<U> : never>
  | Stub<Stubable>
  | Stubable;

interface StubBase<T = unknown> extends Disposable {
  [__RPC_STUB_BRAND]: T;
  dup(): this;
  onRpcBroken(callback: (error: any) => void): void;
}

export type Stub<T extends RpcCompatible<T>> = T extends object
  ? Provider<T> & StubBase<T>
  : StubBase<T>;

type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float32Array
  | Float64Array;

type BaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | TypedArray
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | Blob
  | ReadableStream<Uint8Array>
  | WritableStream<any>
  | Request
  | Response
  | Headers;

export type Stubify<T> = T extends Stubable
  ? Stub<T>
  : T extends Promise<infer U>
    ? Stubify<U>
    : T extends StubBase<any>
      ? T
      : T extends Map<infer K, infer V>
        ? Map<Stubify<K>, Stubify<V>>
        : T extends Set<infer V>
          ? Set<Stubify<V>>
          : T extends []
            ? []
            : T extends [infer Head, ...infer Tail extends unknown[]]
              ? [Stubify<Head>, ...{ [I in keyof Tail]: Stubify<Tail[I]> }]
              : T extends readonly []
                ? readonly []
                : T extends readonly [infer Head, ...infer Tail extends readonly unknown[]]
                  ? readonly [Stubify<Head>, ...{ [I in keyof Tail]: Stubify<Tail[I]> }]
                  : T extends Array<infer V>
                    ? Array<Stubify<V>>
                    : T extends ReadonlyArray<infer V>
                      ? ReadonlyArray<Stubify<V>>
                      : T extends BaseType
                        ? T
                        : T extends { [key: string | number]: any }
                          ? {
                              [K in keyof T as K extends string | number ? K : never]: Stubify<
                                T[K]
                              >;
                            }
                          : T;

type UnstubifyInner<T> =
  T extends StubBase<infer V>
    ? T extends V
      ? UnstubifyInner<V>
      : T | UnstubifyInner<V>
    : T extends Promise<infer U>
      ? UnstubifyInner<U>
      : T extends Map<infer K, infer V>
        ? Map<Unstubify<K>, Unstubify<V>>
        : T extends Set<infer V>
          ? Set<Unstubify<V>>
          : T extends []
            ? []
            : T extends [infer Head, ...infer Tail extends unknown[]]
              ? [Unstubify<Head>, ...{ [I in keyof Tail]: Unstubify<Tail[I]> }]
              : T extends readonly []
                ? readonly []
                : T extends readonly [infer Head, ...infer Tail extends readonly unknown[]]
                  ? readonly [Unstubify<Head>, ...{ [I in keyof Tail]: Unstubify<Tail[I]> }]
                  : T extends Array<infer V>
                    ? Array<Unstubify<V>>
                    : T extends ReadonlyArray<infer V>
                      ? ReadonlyArray<Unstubify<V>>
                      : T extends BaseType
                        ? T
                        : T extends { [key: string | number]: unknown }
                          ? {
                              [K in keyof T as K extends string | number ? K : never]: Unstubify<
                                T[K]
                              >;
                            }
                          : T;

type Unstubify<T> =
  | NonStubMembers<T>
  | UnstubifyInner<T>
  | Promise<UnstubifyInner<T>>
  | MapValuePlaceholder<UnstubifyInner<T>>;

type UnstubifyAll<A extends readonly unknown[]> = { [I in keyof A]: Unstubify<A[I]> };

interface MapValuePlaceholder<T> {
  [__RPC_MAP_VALUE_BRAND]: T;
}

type NonStubMembers<T> = Exclude<T, StubBase<any>>;

type MaybeDisposable<T> = T extends object ? Disposable : unknown;

type Result<R> =
  IsAny<R> extends true
    ? UnknownResult
    : IsUnknown<R> extends true
      ? UnknownResult
      : R extends Stubable
        ? Promise<Stub<R>> & Provider<R> & StubBase<R>
        : R extends RpcCompatible<R>
          ? Promise<Stubify<R> & MaybeDisposable<R>> & Provider<R> & StubBase<R>
          : never;

type IsAny<T> = 0 extends 1 & T ? true : false;
type UnknownResult = Promise<unknown> & Provider<unknown> & StubBase<unknown>;

type MethodOrProperty<V> = V extends (...args: infer P) => infer R
  ? (...args: UnstubifyAll<P>) => IsAny<R> extends true ? UnknownResult : Result<Awaited<R>>
  : Result<Awaited<V>>;

type MaybeCallableProvider<T> = T extends (...args: any[]) => any ? MethodOrProperty<T> : unknown;

type TupleIndexKeys<T extends ReadonlyArray<unknown>> = Extract<keyof T, `${number}`>;

type MapCallbackValue<T> = T extends unknown
  ? Omit<Result<T>, keyof Promise<unknown>> & MaybeCallableProvider<T> & MapValuePlaceholder<T>
  : never;

type InvalidNativePromiseInMapResult<T, Seen = never> = T extends unknown
  ? InvalidNativePromiseInMapResultImpl<T, Seen>
  : never;

type InvalidNativePromiseInMapResultImpl<T, Seen> = [T] extends [Seen]
  ? never
  : T extends StubBase<any>
    ? never
    : T extends PromiseLike<unknown>
      ? T
      : T extends Map<infer K, infer V>
        ?
            | InvalidNativePromiseInMapResult<K, Seen | T>
            | InvalidNativePromiseInMapResult<V, Seen | T>
        : T extends Set<infer V>
          ? InvalidNativePromiseInMapResult<V, Seen | T>
          : T extends readonly []
            ? never
            : T extends readonly [infer Head, ...infer Tail]
              ?
                  | InvalidNativePromiseInMapResult<Head, Seen | T>
                  | InvalidNativePromiseInMapResult<Tail[number], Seen | T>
              : T extends ReadonlyArray<infer V>
                ? InvalidNativePromiseInMapResult<V, Seen | T>
                : T extends { [key: string | number]: unknown }
                  ? InvalidNativePromiseInMapResult<T[Extract<keyof T, string | number>], Seen | T>
                  : never;

type MapCallbackReturn<T> = InvalidNativePromiseInMapResult<T> extends never ? T : never;

type ArrayProvider<E> = {
  [K in number]: MethodOrProperty<E>;
} & {
  map<V>(callback: (elem: MapCallbackValue<E>) => MapCallbackReturn<V>): Result<Array<V>>;
};

type TupleProvider<T extends ReadonlyArray<unknown>> = {
  [K in TupleIndexKeys<T>]: MethodOrProperty<T[K]>;
} & ArrayProvider<T[number]>;

export type Provider<T> = MaybeCallableProvider<T> &
  (T extends ReadonlyArray<unknown>
    ? number extends T["length"]
      ? ArrayProvider<T[number]>
      : TupleProvider<T>
    : {
        [K in Exclude<keyof T, symbol | keyof StubBase<never>>]: MethodOrProperty<T[K]>;
      } & {
        map<V>(
          callback: (value: MapCallbackValue<NonNullable<T>>) => MapCallbackReturn<V>,
        ): Result<Array<V>>;
      });

export type RpcStub<T extends RpcCompatible<T>> = Stub<T>;
export type RpcPromise<T extends RpcCompatible<T>> = Stub<T> & Promise<Stubify<T>>;
