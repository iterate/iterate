import { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http";

//#region src/types.d.ts
// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
// This file borrows heavily from `types/defines/rpc.d.ts` in workerd.
// Branded types for identifying `WorkerEntrypoint`/`DurableObject`/`Target`s.
// TypeScript uses *structural* typing meaning anything with the same shape as type `T` is a `T`.
// For the classes exported by `cloudflare:workers` we want *nominal* typing (i.e. we only want to
// accept `WorkerEntrypoint` from `cloudflare:workers`, not any other class with the same shape)
declare const __RPC_STUB_BRAND: '__RPC_STUB_BRAND';
declare const __RPC_TARGET_BRAND: '__RPC_TARGET_BRAND';
// Distinguishes mapper placeholders from regular values so param unwrapping can accept them.
declare const __RPC_MAP_VALUE_BRAND: unique symbol;
interface RpcTargetBranded {
  [__RPC_TARGET_BRAND]: never;
}
// Types that can be used through `Stub`s
// `never[]` preserves compatibility with strongly-typed function signatures without introducing
// `any` into inference.
type Stubable = RpcTargetBranded | ((...args: never[]) => unknown);
// Note: also true for `any` (call sites that care check `IsAny` first).
type IsUnknown<T> = unknown extends T ? true : false; // Types that can be passed over RPC
// The reason for using a generic type here is to build the serializable subset of RPC-compatible
//   composite types. This allows types defined with the "interface" keyword to pass the
//   serializable check as well. Otherwise, only types defined with the "type" keyword would pass.
type RpcCompatible<T> = // Allow `unknown` as a leaf so records/interfaces with `unknown` fields remain compatible.
(IsUnknown<T> extends true ? unknown : never) // RPC-compatible base values
| BaseType // RPC-compatible composites
| Map<T extends Map<infer U, unknown> ? RpcCompatible<U> : never, T extends Map<unknown, infer U> ? RpcCompatible<U> : never> | Set<T extends Set<infer U> ? RpcCompatible<U> : never> | Array<T extends Array<infer U> ? RpcCompatible<U> : never> | ReadonlyArray<T extends ReadonlyArray<infer U> ? RpcCompatible<U> : never> | { [K in keyof T as K extends string | number ? K : never]: RpcCompatible<T[K]> } | Promise<T extends Promise<infer U> ? RpcCompatible<U> : never> // Special types
| Stub<Stubable> // Serialized as stubs, see `Stubify`
| Stubable;
// Base type for all RPC stubs, including common memory management methods.
// `T` is used as a marker type for unwrapping `Stub`s later.
interface StubBase<T = unknown> extends Disposable {
  [__RPC_STUB_BRAND]: T;
  dup(): this;
  onRpcBroken(callback: (error: any) => void): void;
}
type Stub<T extends RpcCompatible<T>> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
type TypedArray = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | BigUint64Array | BigInt64Array | Float32Array | Float64Array; // This represents all the types that can be sent as-is over an RPC boundary
type BaseType = void | undefined | null | boolean | number | bigint | string | TypedArray | ArrayBuffer | DataView | Date | Error | RegExp | Blob | ReadableStream<any> // Chunk type can be any RPC-compatible type
| WritableStream<any> // Chunk type can be any RPC-compatible type
| URL | Request | Response | Headers; // Recursively rewrite all `Stubable` types with `Stub`s, and resolve promises.
// Arm ordering matters here:
// - `Promise` must come before `StubBase`: `RpcPromise<T>` matches both, and must resolve
//   through the Promise arm rather than pass through as-is.
// - `StubBase` must come before `Stubable`: `Stub<T>` of a callable `T` is itself callable, so
//   it matches `Stubable`. Checking `StubBase` first keeps existing stubs as-is instead of
//   double-wrapping them as `Stub<Stub<T>>`.
// prettier-ignore
type Stubify<T> = T extends Promise<infer U> ? Stubify<U> : T extends StubBase<any> ? T : T extends Stubable ? Stub<T> : T extends Map<infer K, infer V> ? Map<Stubify<K>, Stubify<V>> : T extends Set<infer V> ? Set<Stubify<V>> : T extends [] ? [] : T extends [infer Head, ...infer Tail] ? [Stubify<Head>, ...Stubify<Tail>] : T extends readonly [] ? readonly [] : T extends readonly [infer Head, ...infer Tail] ? readonly [Stubify<Head>, ...Stubify<Tail>] : T extends Array<infer V> ? Array<Stubify<V>> : T extends ReadonlyArray<infer V> ? ReadonlyArray<Stubify<V>> : T extends BaseType ? T // When using "unknown" instead of "any", interfaces are not stubified.
: T extends {
  [key: string | number]: any;
} ? { [K in keyof T as K extends string | number ? K : never]: Stubify<T[K]> } : T;
// Recursively rewrite all `Stub<T>`s with the corresponding `T`s.
// Note we use `StubBase` instead of `Stub` here to avoid circular dependencies:
// `Stub` depends on `Provider`, which depends on `Unstubify`, which would depend on `Stub`.
// prettier-ignore
type UnstubifyInner<T> = // Preserve local RpcTarget acceptance, but avoid needless `Stub | Value` unions when the stub
// is already assignable to the value type (important for callback contextual typing).
T extends StubBase<infer V> ? (T extends V ? UnstubifyInner<V> : (T | UnstubifyInner<V>)) : T extends Promise<infer U> ? UnstubifyInner<U> : T extends Map<infer K, infer V> ? Map<Unstubify<K>, Unstubify<V>> : T extends Set<infer V> ? Set<Unstubify<V>> : T extends [] ? [] : T extends [infer Head, ...infer Tail] ? [Unstubify<Head>, ...Unstubify<Tail>] : T extends readonly [] ? readonly [] : T extends readonly [infer Head, ...infer Tail] ? readonly [Unstubify<Head>, ...Unstubify<Tail>] : T extends Array<infer V> ? Array<Unstubify<V>> : T extends ReadonlyArray<infer V> ? ReadonlyArray<Unstubify<V>> : T extends BaseType ? T : T extends {
  [key: string | number]: unknown;
} ? { [K in keyof T as K extends string | number ? K : never]: Unstubify<T[K]> } : T; // You can put promises anywhere in the params and they'll be resolved before delivery.
// (This also covers RpcPromise, because it's defined as being a Promise.)
// Map placeholders are also allowed so primitive map callback inputs can be forwarded directly
// into RPC params.
//
// Keep raw non-stub members so generic assignability still works when UnstubifyInner<T> is deferred.
// Remove stub members from mixed unions so callback params don’t get both stub and unstubbed signatures.
// Marker carried by map() callback inputs. This lets primitive placeholders flow through params.
type Unstubify<T> = NonStubMembers<T> | UnstubifyInner<T> | Promise<UnstubifyInner<T>> | MapValuePlaceholder<UnstubifyInner<T>>;
type UnstubifyAll<A extends readonly unknown[]> = { [I in keyof A]: Unstubify<A[I]> };
interface MapValuePlaceholder<T> {
  [__RPC_MAP_VALUE_BRAND]: T;
}
type NonStubMembers<T> = Exclude<T, StubBase<any>>; // Utility type for adding `Disposable`s to `object` types only.
// Note `unknown & T` is equivalent to `T`.
type MaybeDisposable<T> = T extends object ? Disposable : unknown; // The type behind the public `RpcPromise` (re-exported with its `RpcCompatible` constraint from
// index.ts). Defined here so that `Result`'s arms below resolve to the exact same alias
// instantiation: when both sides of an assignability check are the same alias applied to the
// same type arguments, the checker short-circuits on identity instead of recursing through the
// full structural comparison of these mutually-recursive types.
type RpcPromise$1<T> = T extends Stubable ? Promise<Stub<T>> & Provider<T> & StubBase<T> : Promise<Stubify<T> & MaybeDisposable<T>> & Provider<T> & StubBase<T>;
// The elision `Result` applies to a bare stub type: unwrap `Stub<T>` back to `T` when the
// payload is `Stubable`. Such stubs await back to a stub either way, so eliding keeps a
// declared `Promise<RpcStub<T>>` return interchangeable with a `Promise<T>` return.
// Plain-interface stubs are NOT elided: `RpcPromise<U>` only awaits to `Stub<U>` when
// `U extends Stubable`, so eliding those would change the awaited type from a stub to a
// stubified record. The payload check is deliberately non-distributive (`[U] extends [...]`).
// `Stub<any>` is not elided either: `[any] extends [Stubable]` is true, so without the `IsAny`
// guard an `any`-payload stub would lose its stub surface.
// Also used by the `RpcPromise` constructor signature (index.ts), which applies exactly this
// transformation so constructing from a promised stub matches the method-return type.
type ElideStub<T> = T extends StubBase<infer U> ? (IsAny<U> extends true ? T : [U] extends [Stubable] ? U : T) : T;
// What the promise given to `new RpcPromise<T>(...)` may resolve to: the payload itself, or —
// for stubable payloads — a stub of it. `NoInfer` keeps the stub arm out of inference, so an
// inferred `T` is always the promise's own resolution type; the arm only matters when `T` is
// explicitly annotated (`new RpcPromise<Counter>(promiseOfStub)`). Stubs of non-stubable
// payloads are deliberately rejected: `ElideStub` wouldn't elide those, so accepting one would
// claim the promise awaits to a stubified record while the runtime resolves to a stub.
type PayloadOrStub<T> = T | NoInfer<Stub<Extract<T, Stubable>>>;
// Type for method return or property on an RPC interface.
// - Stubable types are replaced by stubs.
// - RpcCompatible types are passed by value, with stubable types replaced by stubs
//   and a top-level `Disposer`.
// Everything else can't be passed over RPC.
// Technically, we use custom thenables here, but they quack like `Promise`s.
// Intersecting with `(Maybe)Provider` allows pipelining.
// prettier-ignore
type Result<R> = IsAny<R> extends true ? RpcPromise$1<unknown> // `RpcPromise<U>`: always safe to normalize — `Result` is idempotent — so a declared
// `RpcPromise<U>` return produces the same type as a `Promise<U>` return.
: R extends PromiseLike<unknown> & StubBase<infer U> ? Result<U> // Bare stubs: elide per `ElideStub` above. Note there is no `RpcCompatible<R>` re-check
// here: anything matching our `StubBase` was produced by machinery that already enforced
// the constraint, and re-evaluating `RpcCompatible<R>` in this arm recurses through its
// `Stub<Stubable>` member back into `Result`, tripping TS2615 circularity errors in mapped
// types.
: R extends StubBase<any> ? RpcPromise$1<ElideStub<R>> : R extends RpcCompatible<R> ? RpcPromise$1<R> : never;
type IsAny<T> = 0 extends (1 & T) ? true : false; // Type for method or property on an RPC interface.
// For methods, unwrap `Stub`s in parameters, and rewrite returns to be `Result`s.
// Unwrapping `Stub`s allows calling with `Stubable` arguments.
// For properties, rewrite types to be `Result`s.
// In each case, unwrap `Promise`s.
type MethodOrProperty<V> = V extends ((...args: infer P) => infer R) ? (...args: UnstubifyAll<P>) => Result<Awaited<R>> : Result<Awaited<V>>; // Type for the callable part of an `Provider` if `T` is callable.
// This is intersected with methods/properties.
type MaybeCallableProvider<T> = T extends ((...args: any[]) => any) ? MethodOrProperty<T> : unknown;
type TupleIndexKeys<T extends ReadonlyArray<unknown>> = Extract<keyof T, `${number}`>;
type MapCallbackValue<T> = // `Omit` removes call signatures, so re-intersect callable provider behavior.
T extends unknown ? Omit<Result<T>, keyof Promise<unknown>> & MaybeCallableProvider<T> & MapValuePlaceholder<T> : never;
type InvalidNativePromiseInMapResult<T, Seen = never> = T extends unknown ? InvalidNativePromiseInMapResultImpl<T, Seen> : never;
type InvalidNativePromiseInMapResultImpl<T, Seen> = [T] extends [Seen] ? never // RpcPromise is modeled as Promise & StubBase, so allow promise-like stub values.
: T extends StubBase<any> ? never // Native thenables cannot be represented in map recordings, even when typed as PromiseLike.
: T extends PromiseLike<unknown> ? T : T extends Map<infer K, infer V> ? InvalidNativePromiseInMapResult<K, Seen | T> | InvalidNativePromiseInMapResult<V, Seen | T> : T extends Set<infer V> ? InvalidNativePromiseInMapResult<V, Seen | T> : T extends readonly [] ? never : T extends readonly [infer Head, ...infer Tail] ? InvalidNativePromiseInMapResult<Head, Seen | T> | InvalidNativePromiseInMapResult<Tail[number], Seen | T> : T extends ReadonlyArray<infer V> ? InvalidNativePromiseInMapResult<V, Seen | T> : T extends {
  [key: string | number]: unknown;
} ? InvalidNativePromiseInMapResult<T[Extract<keyof T, string | number>], Seen | T> : never;
type MapCallbackReturn<T> = InvalidNativePromiseInMapResult<T> extends never ? T : never;
type ArrayProvider<E> = { [K in number]: MethodOrProperty<E> } & {
  map<V>(callback: (elem: MapCallbackValue<E>) => MapCallbackReturn<V>): Result<Array<V>>;
};
type TupleProvider<T extends ReadonlyArray<unknown>> = { [K in TupleIndexKeys<T>]: MethodOrProperty<T[K]> } & ArrayProvider<T[number]>; // Base type for all other types providing RPC-like interfaces.
// Rewrites all methods/properties to be `MethodOrProperty`s, while preserving callable types.
// `__RPC_TARGET_BRAND` deliberately flows through the key mapping (as a `never` property) so
// stubs of branded targets stay assignable to workers-types' `Stubable`. Such stubs match our
// `Stubable` too — harmless, since all machinery checks `StubBase` before `Stubable`.
type Provider<T> = MaybeCallableProvider<T> & (T extends ReadonlyArray<unknown> ? number extends T["length"] ? ArrayProvider<T[number]> : TupleProvider<T> : { [K in Exclude<keyof T, symbol | keyof StubBase<never>>]: MethodOrProperty<T[K]> } & {
  map<V>(callback: (value: MapCallbackValue<NonNullable<T>>) => MapCallbackReturn<V>): Result<Array<V>>;
});
//#endregion
//#region src/core.d.ts
type PropertyPath = (string | number)[];
/** Information about one application function invocation received over RPC. */
type RpcCallInfo = {
  /** The property path used to reach the function from the referenced capability. */path: PropertyPath; /** The object that owns the function, or the function itself for a callable capability. */
  target: unknown;
};
/**
 * Wraps one local application invocation. `invoke()` must be called synchronously so Cap'n Web's
 * e-order guarantees are preserved, but the returned promise remains pending for the full call.
 */
type RpcCallHandler = <T>(info: RpcCallInfo, invoke: () => Promise<T>) => Promise<T>;
//#endregion
//#region src/serialize.d.ts
/**
 * Encoding levels determine what representation the RPC system hands to the transport.
 * Each level names what the transport can assume about message values.
 *
 * - `"string"`: JSON string. Default, used by HTTP batch and WebSocket transports.
 * - `"jsonCompatible"`: JSON-compatible JS value tree. For custom encoders.
 * - `"jsonCompatibleWithBytes"`: Like `"jsonCompatible"` but Uint8Array stays raw.
 * - `"structuredClonable"`: Structured-clonable native values pass through where possible.
 *
 * @example
 * ```ts
 * // What happens to Uint8Array([1, 2, 3]) at each level:
 * "string"          → '["bytes","AQID"]'           // JSON string with base64
 * "jsonCompatible"          → ["bytes", "AQID"]      // JS array with base64
 * "jsonCompatibleWithBytes" → ["bytes", Uint8Array]  // JS array with raw bytes
 * "structuredClonable"      → ["bytes", Uint8Array]  // + Date, BigInt stay native
 * ```
 */
type EncodingLevel = "string" | "jsonCompatible" | "jsonCompatibleWithBytes" | "structuredClonable";
interface RpcLimits {
  maxBigIntDigits: number;
  maxDepth: number;
  maxMessageSize: number;
}
declare const DEFAULT_MAX_DEPTH = 256;
declare const DEFAULT_LIMITS: RpcLimits;
/**
 * Serialize a value, using Cap'n Web's underlying serialization. This won't be able to serialize
 * RPC stubs, but it will support basic data types.
 */
declare function serialize(value: unknown): string;
/**
 * Deserialize a value serialized using serialize().
 */
declare function deserialize(value: string): unknown;
//#endregion
//#region src/rpc.d.ts
/**
 * Interface for a string-based RPC transport. This is the default transport type — no
 * `encodingLevel` field is needed. Messages are JSON strings. Implement this interface if the
 * built-in transports (e.g. for HTTP batch and WebSocket) don't meet your needs.
 */
interface RpcTransport {
  /**
   * The encoding level this transport works with. For this interface it is always "string";
   * it may be omitted. (See `RpcTransportWithCustomEncoding` for the other levels.)
   */
  readonly encodingLevel?: "string";
  /**
   * Sends a message to the other end. May optionally return a promise; if the promise rejects,
   * the session is aborted.
   */
  send(message: string): void | Promise<void>;
  /**
   * Receives a message sent by the other end.
   *
   * If and when the transport becomes disconnected, this will reject. The thrown error will be
   * propagated to all outstanding calls and future calls on any stubs associated with the session.
   * If there are no outstanding calls (and none are made in the future), then the error does not
   * propagate anywhere -- this is considered a "clean" shutdown.
   */
  receive(): Promise<string>;
  /**
   * Indicates that the RPC system has suffered an error that prevents the session from continuing.
   * The transport should ideally try to send any queued messages if it can, and then close the
   * connection. (It's not strictly necessary to deliver queued messages, but the last message sent
   * before abort() is called is often an "abort" message, which communicates the error to the
   * peer, so if that is dropped, the peer may have less information about what happened.)
   */
  abort?(reason: any): void;
}
/**
 * Interface for a transport that receives partially encoded JS values instead of JSON strings.
 * The selected `encodingLevel` describes what the transport can assume about message values.
 */
interface RpcTransportWithCustomEncoding {
  /**
   * The encoding level this transport works with.
   *
   * - "jsonCompatible": JSON-compatible JS value tree; transport handles final serialization.
   * - "jsonCompatibleWithBytes": Like "jsonCompatible" but Uint8Array values are left raw.
   * - "structuredClonable": Structured-clonable native values pass through where possible.
   */
  readonly encodingLevel: "jsonCompatible" | "jsonCompatibleWithBytes" | "structuredClonable";
  /**
   * Encodes and sends a message to the other end. Returns the encoded byte size if known.
   * If the size is unavailable, return void; Cap'n Web will estimate stream message sizes for
   * flow control. Send errors should be propagated via `receive()` rejecting.
   */
  send(message: unknown): number | void;
  /**
   * Receives and decodes a message sent by the other end.
   *
   * If and when the transport becomes disconnected, this will reject. The thrown error will be
   * propagated to all outstanding calls and future calls on any stubs associated with the session.
   * If there are no outstanding calls (and none are made in the future), then the error does not
   * propagate anywhere -- this is considered a "clean" shutdown.
   */
  receive(): Promise<unknown>;
  /**
   * Indicates that the RPC system has suffered an error that prevents the session from continuing.
   * The transport should ideally try to send any queued messages if it can, and then close the
   * connection. (It's not strictly necessary to deliver queued messages, but the last message sent
   * before abort() is called is often an "abort" message, which communicates the error to the
   * peer, so if that is dropped, the peer may have less information about what happened.)
   */
  abort?(reason: any): void;
}
/** Any supported transport type. */
type AnyRpcTransport = RpcTransport | RpcTransportWithCustomEncoding;
/**
 * Options to customize behavior of an RPC session. All functions which start a session should
 * optionally accept this.
 */
type RpcSessionOptions = {
  /**
   * If provided, this function will be called whenever an `Error` object is serialized (for any
   * reason, not just because it was thrown). This can be used to log errors, and also to redact
   * them.
   *
   * If `onSendError` returns an Error object, than object will be substituted in place of the
   * original. If it has a stack property, the stack will be sent to the client.
   *
   * If `onSendError` doesn't return anything (or is not provided at all), the default behavior is
   * to serialize the error with the stack omitted.
   */
  onSendError?: (error: Error) => Error | void;
  /**
   * Overrides for the resource limits enforced while deserializing messages from the peer. Any
   * field left unset falls back to `DEFAULT_LIMITS`. These guard against resource-exhaustion
   * attacks from untrusted peers; see `RpcLimits` for the meaning and defaults of each field.
   *
   * Limits are a purely local, receiver-side decision -- the protocol has no negotiation step, so
   * the peer never learns these values. A message that exceeds a limit is rejected, aborting the
   * session.
   */
  limits?: Partial<RpcLimits>;
  /**
   * Wrap every local application function invoked by the peer. The handler must invoke
   * `invoke()` synchronously to preserve e-order, and should return its promise so the wrapper
   * spans the full asynchronous call. The hook is propagated through promise pipelining.
   */
  onCall?: RpcCallHandler;
};
//#endregion
//#region src/websocket.d.ts
/**
 * For use in Cloudflare Workers: Construct an HTTP response that starts a WebSocket RPC session
 * with the given `localMain`.
 */
declare function newWorkersWebSocketRpcResponse(request: Request, localMain?: any, options?: RpcSessionOptions): Response;
/**
 * Generic WebSocket transport. Default `T = string` is backward-compatible and satisfies
 * `RpcTransport`. Use `T = ArrayBuffer` as a building block for binary transports.
 */
declare class WebSocketTransport<T extends string | ArrayBuffer = string> {
  #private;
  constructor(webSocket: WebSocket);
  send(message: T): void;
  receive(): Promise<T>;
  abort(reason: any): void;
}
//#endregion
//#region src/batch.d.ts
/**
 * Implements the server end of an HTTP batch session, using standard Fetch API types to represent
 * HTTP requests and responses.
 *
 * @param request The request received from the client initiating the session.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options.
 * @returns The HTTP response to return to the client. Note that the returned object has mutable
 *     headers, so you can modify them using e.g. `response.headers.set("Foo", "bar")`.
 */
declare function newHttpBatchRpcResponse(request: Request, localMain: any, options?: RpcSessionOptions): Promise<Response>;
/**
 * Implements the server end of an HTTP batch session using traditional Node.js HTTP APIs.
 *
 * @param request The request received from the client initiating the session.
 * @param response The response object, to which the response should be written.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options. You can also pass headers to set on the response.
 */
declare function nodeHttpBatchRpcResponse(request: IncomingMessage, response: ServerResponse, localMain: any, options?: RpcSessionOptions & {
  headers?: OutgoingHttpHeaders | OutgoingHttpHeader[];
}): Promise<void>;
//#endregion
//#region src/websocket-streams.d.ts
/**
 * The subset of the WebSocket API that the tunnel relies on. Covers browser WebSockets, `ws` /
 * undici client sockets, Cloudflare Workers WebSockets (which add accept()), one half of a
 * `WebSocketPair`, and a tunneled socket received from another session (which is what we wrap
 * when proxying an already-tunneled socket onward to a third party).
 */
interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  binaryType?: string;
}
/**
 * Constructs a `Response` that answers a `fetch()` with a WebSocket upgrade, carrying
 * `webSocket` -- the universal spelling of what Cloudflare Workers code writes as
 * `new Response(null, { status: 101, webSocket })`.
 *
 * On Workers this produces exactly that native Response, so it can also be returned straight
 * from a real fetch handler. On every other runtime -- where the standard Response constructor
 * refuses to produce 1xx statuses -- it produces a status-200 `Response` (any `init.status` /
 * `init.statusText` is stripped) carrying `webSocket` as the non-standard own-property. The two
 * are identical on the wire: an upgrade implies status 101, so the status is never serialized.
 * `init.headers` (e.g. a negotiated Sec-WebSocket-Protocol) rides along.
 *
 * The socket's frames begin tunneling toward the receiver the moment the Response is
 * serialized, and a socket can be sent over RPC only once. Note the passthrough caveat: for
 * sockets without accept() (e.g. `ws` or browser sockets being proxied through), frames that
 * arrive between the dial's open and the Response's serialization are dropped -- Cap'n Web is
 * the first to see the socket at serialization time. Either await open and accept that window
 * (fine for servers that speak second), or wrap the socket in a `WebSocketPair` as you dial and
 * answer with the other half (for servers that speak first; the pair buffers).
 *
 * On Workers, passing a socket that is not a native `WebSocket` instance falls back to the
 * status-200 own-property spelling: such a Response still tunnels over RPC (the serializer
 * duck-types the property), but cannot complete a real HTTP upgrade from a fetch handler --
 * the runtime demands a native socket for that.
 */
declare function upgradeWebSocketResponse(webSocket: WebSocketLike, init?: ResponseInit): Response;
type WebSocketPairHalf = {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void, options?: {
    once?: boolean;
  }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};
/**
 * Two crosswired WebSocket halves: whatever is sent on one is received by the other. On
 * Cloudflare Workers this IS the native `WebSocketPair` (aliased at module load, so there is
 * exactly one behavior per platform); elsewhere it is a pure-JavaScript pair with workerd
 * semantics -- halves born OPEN (no "open" event ever fires), each buffering inbound messages
 * without bound until its accept() is called, delivery always asynchronous, and RFC 6455
 * half-close: a half that close()s can no longer send but KEEPS RECEIVING until its peer
 * closes back, and both halves reach CLOSED only once both have closed. A half never hears a
 * close event for its own close(). (The KEEPS-RECEIVING window exists between the two halves
 * only -- the RPC tunnel itself does not implement half-close, so frames sent after a
 * tunnel-initiated close do not reach the tunnel's other end.)
 *
 * The pure-JS pair diverges from native workerd in exactly four deliberate ways:
 *
 * - Binary frames are COPIED at send() time. Native workerd does not copy -- an in-flight
 *   frame aliases the sender's buffer, so mutating a scratch buffer after send() corrupts
 *   frames on Workers. Don't rely on the copy in cross-platform code.
 * - Events are plain objects (`{type, data}` / `{type, code, reason, wasClean}`), matching the
 *   tunneled sockets this library produces -- not MessageEvent/CloseEvent instances as on
 *   workerd.
 * - A throwing listener is reported via console.error and delivery continues; native workerd
 *   permanently stops delivering to a half whose listener threw.
 * - A close handshake always completes cleanly: the closing half hears the responding close's
 *   real code/reason (wasClean true). Native does the same on plain handshakes, but reports a
 *   1006 disconnect instead when data frames interleave with the handshake in certain orders
 *   -- an internal-pump artifact this pair does not reproduce.
 *
 * Use it when the provider answering an upgrade IS the endpoint, with no underlying socket to
 * pass through:
 *
 *     let pair = new WebSocketPair();
 *     pair[1].accept();
 *     pair[1].addEventListener("message", event => pair[1].send(`echo: ${event.data}`));
 *     return upgradeWebSocketResponse(pair[0]);
 *
 * ...or to wrap an upstream socket whose server speaks first: wire the socket to one half as
 * you dial, and answer with the other half -- the pair buffers frames that would otherwise be
 * dropped before the Response is serialized.
 */
declare const WebSocketPair: new () => {
  0: WebSocketPairHalf;
  1: WebSocketPairHalf;
};
//#endregion
//#region src/index.d.ts
/**
 * Represents a reference to a remote object, on which methods may be remotely invoked via RPC.
 *
 * `RpcStub` can represent any interface (when using TypeScript, you pass the specific interface
 * type as `T`, but this isn't known at runtime). The way this works is, `RpcStub` is actually a
 * `Proxy`. It makes itself appear as if every possible method / property name is defined. You can
 * invoke any method name, and the invocation will be sent to the server. If it turns out that no
 * such method exists on the remote object, an exception is thrown back. But the client does not
 * actually know, until that point, what methods exist.
 */
type RpcStub<T extends RpcCompatible<T>> = Stub<T>;
declare const RpcStub: {
  new <T extends RpcCompatible<T>>(value: T): RpcStub<T>;
};
/**
 * Represents the result of an RPC call.
 *
 * Also used to represent properties. That is, `stub.foo` evaluates to an `RpcPromise` for the
 * value of `foo`.
 *
 * This isn't actually a JavaScript `Promise`. It does, however, have `then()`, `catch()`, and
 * `finally()` methods, like `Promise` does, and because it has a `then()` method, JavaScript will
 * allow you to treat it like a promise, e.g. you can `await` it.
 *
 * An `RpcPromise` is also a proxy, just like `RpcStub`, where calling methods or awaiting
 * properties will make a pipelined network request.
 *
 * Note that and `RpcPromise` is "lazy": the actual final result is not requested from the server
 * until you actually `await` the promise (or call `then()`, etc. on it). This is an optimization:
 * if you only intend to use the promise for pipelining and you never await it, then there's no
 * need to transmit the resolution!
 *
 * You may also construct an `RpcPromise` yourself from a regular `Promise`, using
 * `new RpcPromise(promise)`, allowing you to perform promise pipelining on a local promise. This
 * is semantically identical to creating a local-loopback RPC that returns the promise, and then
 * invoking it: pipelined calls wait until the promise resolves, then are delivered, in order, to
 * the resolution. This is useful when you plan to obtain some stub in the future, but want to
 * allow code to start queuing calls on it immediately. Note that the `RpcPromise` takes
 * ownership of the resolution: disposing it disposes the resolution, so resolve the promise
 * with a `dup()` if you also intend to keep the stub.
 */
type RpcPromise<T extends RpcCompatible<T>> = RpcPromise$1<T>;
declare const RpcPromise: {
  new <T extends RpcCompatible<T>>(value: Promise<T>): RpcPromise$1<ElideStub<T>>;
  new <T extends RpcCompatible<T>>(value: Promise<PayloadOrStub<T>>): RpcPromise$1<ElideStub<T>>;
};
/**
 * Use to construct an `RpcSession` on top of a custom `RpcTransport`.
 *
 * Most people won't use this. You only need it if you've implemented your own `RpcTransport`.
 */
interface RpcSession<T extends RpcCompatible<T> = undefined> {
  getRemoteMain(): RpcStub<T>;
  getStats(): {
    imports: number;
    exports: number;
  };
  drain(): Promise<void>;
}
declare const RpcSession: {
  new <T extends RpcCompatible<T> = undefined>(transport: AnyRpcTransport, localMain?: any, options?: RpcSessionOptions): RpcSession<T>;
};
/**
 * Classes which are intended to be passed by reference and called over RPC must extend
 * `RpcTarget`. A class which does not extend `RpcTarget` (and which doesn't have built-in support
 * from the RPC system) cannot be passed in an RPC message at all; an exception will be thrown.
 *
 * Note that on Cloudflare Workers, this `RpcTarget` is an alias for the one exported from the
 * "cloudflare:workers" module, so they can be used interchangably.
 */
interface RpcTarget extends RpcTargetBranded {}
declare const RpcTarget: {
  new (): RpcTarget;
};
/**
 * Empty interface used as default type parameter for sessions where the other side doesn't
 * necessarily export a main interface.
 */
interface Empty {}
/**
 * Start a WebSocket session given either an already-open WebSocket or a URL.
 *
 * @param webSocket Either the `wss://` URL to connect to, or an already-open WebSocket object to
 * use.
 * @param localMain The main RPC interface to expose to the peer. Returns a stub for the main
 * interface exposed from the peer.
 */
declare let newWebSocketRpcSession: <T extends RpcCompatible<T> = Empty>(webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions) => RpcStub<T>;
/**
 * Initiate an HTTP batch session from the client side.
 *
 * The parameters to this method have exactly the same signature as `fetch()`, but the return
 * value is an RpcStub. You can customize anything about the request except for the method
 * (it will always be set to POST) and the body (which the RPC system will fill in).
 */
declare let newHttpBatchRpcSession: <T extends RpcCompatible<T>>(urlOrRequest: string | Request, options?: RpcSessionOptions) => RpcStub<T>;
/**
 * Initiate an RPC session over a MessagePort, which is particularly useful for communicating
 * between an iframe and its parent frame in a browser context. Each side should call this function
 * on its own end of the MessageChannel.
 */
declare let newMessagePortRpcSession: <T extends RpcCompatible<T> = Empty>(port: MessagePort, localMain?: any, options?: RpcSessionOptions) => RpcStub<T>;
/**
 * Implements unified handling of HTTP-batch and WebSocket responses for the Cloudflare Workers
 * Runtime.
 *
 * SECURITY WARNING: This function accepts cross-origin requests. If you do not want this, you
 * should validate the `Origin` header before calling this, or use `newHttpBatchRpcSession()` and
 * `newWebSocketRpcSession()` directly with appropriate security measures for each type of request.
 * But if your API uses in-band authorization (i.e. it has an RPC method that takes the user's
 * credentials as parameters and returns the authorized API), then cross-origin requests should
 * be safe.
 */
declare function newWorkersRpcResponse(request: Request, localMain: any, options?: RpcSessionOptions): Promise<Response>;
//#endregion
export { type AnyRpcTransport, DEFAULT_LIMITS, DEFAULT_MAX_DEPTH, type EncodingLevel, type RpcCallInfo, type RpcCompatible, type RpcLimits, RpcPromise, RpcSession, type RpcSessionOptions, RpcStub, RpcTarget, type RpcTransport, type RpcTransportWithCustomEncoding, type WebSocketLike, WebSocketPair, WebSocketTransport, deserialize, newHttpBatchRpcResponse, newHttpBatchRpcSession, newMessagePortRpcSession, newWebSocketRpcSession, newWorkersRpcResponse, newWorkersWebSocketRpcResponse, nodeHttpBatchRpcResponse, serialize, upgradeWebSocketResponse };
//# sourceMappingURL=index.d.ts.map