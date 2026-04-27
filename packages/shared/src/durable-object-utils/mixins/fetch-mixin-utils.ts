/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/**
 * Generic Durable Object class value used by fetch-wrapper mixins.
 *
 * Cloudflare-style mixins need to preserve this call-site shape:
 *
 *   const Base = withKvInspector(...)(DurableObject);
 *   class Room extends Base<Env> {}
 *
 * `ReqEnv` is the minimum Env required by mixins applied so far. `Members` is
 * the instance surface accumulated so far. Keeping both in one constructor type
 * lets later mixins add routes while retaining earlier env requirements and
 * methods.
 */
export type DurableObjectClass<ReqEnv = unknown, Members = object> = abstract new <
  Env extends ReqEnv,
>(
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & Members;

export type ReqEnvOf<C> =
  C extends DurableObjectClass<infer ReqEnv, infer _Members> ? ReqEnv : unknown;

export type MembersOf<C> =
  C extends DurableObjectClass<infer _ReqEnv, infer Members> ? Members : object;

/**
 * Copy static properties without copying the original constructor signature.
 *
 * Intersecting two constructor signatures can make TypeScript require both
 * constructors to return the exact same instance type, which breaks composed
 * mixins. StaticSide<TBase> keeps useful statics while WithFetchMixinResult
 * below supplies one fresh generic Durable Object constructor.
 */
export type StaticSide<T> = {
  [K in keyof T]: T[K];
};

export type RuntimeDurableObjectConstructor = abstract new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject;

type DurableObjectInternals = {
  ctx: DurableObjectState;
};

export type FetchBase = {
  fetch(request: Request): Response | Promise<Response>;
};

type OptionalFetchBase = {
  fetch?(request: Request): Response | Promise<Response>;
};

/**
 * Public result type for mixins that add or wrap fetch().
 *
 * Benefit:
 *
 *   const Base = withKvInspector(...)(withOuterbase(...)(DurableObject));
 *   class Room extends Base<Env> {}
 *
 * The composed class remains generic in Env, statics from the wrapped class are
 * preserved, and the instance type now includes fetch().
 */
export type WithFetchMixinResult<TBase extends DurableObjectClass> = StaticSide<TBase> &
  DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & FetchBase>;

/**
 * Delegate to the wrapped class's fetch() when a mixin does not own a route.
 *
 * Fetch mixins compose by trying their route first, then passing through to the
 * base class. If no lower layer handles fetch(), return a plain 404. This keeps
 * each inspector focused on its own route instead of duplicating fallback logic.
 */
export async function delegateToBaseFetch(
  Base: DurableObjectClass,
  instance: object,
  request: Request,
): Promise<Response> {
  const baseFetch = (Base.prototype as OptionalFetchBase).fetch;
  if (baseFetch !== undefined) return await baseFetch.call(instance, request);

  return new Response("Not found", { status: 404 });
}

/**
 * Local escape hatch for protected DurableObject internals.
 *
 * The constructor constraint proves inspector mixins only wrap DurableObject
 * classes. `ctx` is protected, so route helpers that need SQLite/KV access use
 * this one narrow cast rather than spreading protected-field casts through each
 * inspector implementation.
 */
export function getDurableObjectState(instance: object): DurableObjectState {
  return (instance as unknown as DurableObjectInternals).ctx;
}
