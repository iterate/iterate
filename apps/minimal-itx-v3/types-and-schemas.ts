/**
 * Minimal ITX v3 public contract.
 *
 * This is the one file a caller should need to understand the model.
 *
 * ITX is a project-local capability tree. A caller first receives an
 * `UnauthenticatedItx`, calls `authenticate(...)`, and then walks ordinary
 * TypeScript objects: projects, streams, repos, agents, the project worker, and
 * any dynamic capabilities mounted at runtime.
 *
 * Stream append is deliberately synchronous because the Stream Durable Object
 * owns the append transaction. Operations that cross into another Durable
 * Object or dynamic worker return promises in the raw interface.
 *
 * ```ts
 * using unauthenticated = connect<UnauthenticatedItx>(itxWebSocketUrl);
 * using itx = unauthenticated.authenticate({
 *   auth: { type: "token", token: "alice-token" },
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
  authenticate(input?: ItxConnectInput): RootItx | Project | AgentItx;
}

export type ItxConnectInput = {
  auth?: ItxAuth;
  projectId?: string;
  path?: string;
};

export type ItxAuth =
  | { type: "from-server-cookie" }
  | { type: "token"; token: string }
  | { type: "trusted-internal"; token: string };

export interface RootItx {
  projects: Projects;
}

export interface Projects {
  get(projectId: string): Project;
  create(projectId: string): Promise<StreamEvent>;
  list(): string[];
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
  agents: Agents;
  repos: Repos;
  repo: Repo;
  worker: ProjectWorker;

  create(): Promise<StreamEvent>;
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

export interface Stream {
  append(input: { event: StreamEventInput }): StreamEvent;
  appendBatch(input: { events: StreamEventInput[] }): StreamEvent[];
  getEvents(input?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): StreamEvent[];
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
    result: Json;
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
        props?: Record<string, Json>;
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
  payload?: Json;
  metadata?: Record<string, Json>;
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

export type Access = "all" | string[];

export type Principal = {
  name: string;
  access: Access;
};

type JsonDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];
type JsonValue<Depth extends number> =
  | null
  | boolean
  | number
  | string
  | (Depth extends 0 ? never : JsonValue<JsonDepth[Depth]>[])
  | (Depth extends 0 ? never : { [key: string]: JsonValue<JsonDepth[Depth]> });

export type Json = JsonValue<8>;

export type RpcTargetImplementation<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result | Promise<Result>
    : T[K] | Promise<T[K]>;
};

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
